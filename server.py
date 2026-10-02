"""Serve Daymark locally and proxy study-plan requests to Gemini."""

import json
import mimetypes
import os
import re
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urlencode, urlsplit
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
HOST = "127.0.0.1"
PORT = int(os.environ.get("DAYMARK_PORT", "8000"))
MAX_REQUEST_BYTES = 20_000
MAX_TOPICS = 30
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")


class DaymarkHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if urlsplit(self.path).path == "/api/study-plan":
            self.send_json(405, {"error": "Use POST to generate a study plan."})
            return

        requested_path = unquote(urlsplit(self.path).path).lstrip("/")
        if not requested_path:
            requested_path = "home.html"

        file_path = (ROOT / requested_path).resolve()
        if not file_path.is_relative_to(ROOT) or not file_path.is_file():
            self.send_error(404, "Page not found.")
            return
        if any(part.startswith(".") for part in file_path.relative_to(ROOT).parts):
            self.send_error(404, "Page not found.")
            return

        content = file_path.read_bytes()
        content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_security_headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)

    def do_POST(self):
        if urlsplit(self.path).path != "/api/study-plan":
            self.send_json(404, {"error": "API endpoint not found."})
            return

        if not self.is_same_origin():
            self.send_json(403, {"error": "Requests must come from this Daymark server."})
            return

        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            self.send_json(415, {"error": "Send study-plan details as JSON."})
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json(400, {"error": "Invalid request length."})
            return
        if content_length <= 0 or content_length > MAX_REQUEST_BYTES:
            self.send_json(413, {"error": "Study-plan request is empty or too large."})
            return

        try:
            payload = json.loads(self.rfile.read(content_length))
            request_data = validate_study_request(payload)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
            self.send_json(400, {"error": str(error)})
            return

        api_key = os.environ.get("GEMINI_API_KEY", "").strip()
        if not api_key:
            self.send_json(503, {"error": "Gemini is not configured. Set GEMINI_API_KEY in the server environment and restart Daymark."})
            return

        try:
            sessions = generate_plan(api_key, request_data)
        except HTTPError as error:
            provider_message = read_provider_error(error)
            self.send_json(502, {"error": f"Gemini request failed (HTTP {error.code}): {provider_message}"})
            return
        except (URLError, TimeoutError) as error:
            self.send_json(502, {"error": f"Could not reach Gemini: {error.reason if isinstance(error, URLError) else error}"})
            return
        except (json.JSONDecodeError, KeyError, IndexError, TypeError, ValueError) as error:
            self.send_json(502, {"error": f"Gemini returned an invalid study plan: {error}"})
            return

        self.send_json(200, {"sessions": sessions})

    def is_same_origin(self):
        origin = self.headers.get("Origin")
        if not origin:
            return False
        parsed_origin = urlsplit(origin)
        host = self.headers.get("Host", "")
        return parsed_origin.scheme in ("http", "https") and parsed_origin.netloc.lower() == host.lower()

    def send_security_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("X-Frame-Options", "DENY")

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_security_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format_string, *args):
        if self.command == "POST":
            return
        super().log_message(format_string, *args)


def validate_study_request(payload):
    if not isinstance(payload, dict):
        raise ValueError("Request body must be a JSON object.")

    subject = payload.get("subject")
    exam_date = payload.get("examDate")
    daily_minutes = payload.get("dailyMinutes")
    topics = payload.get("topics")
    if not isinstance(subject, str) or not subject.strip() or len(subject) > 80:
        raise ValueError("Enter a subject name of 1 to 80 characters.")
    if not isinstance(exam_date, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", exam_date):
        raise ValueError("Choose an exam date.")
    try:
        parsed_exam_date = date.fromisoformat(exam_date)
    except ValueError as error:
        raise ValueError("Exam date must use YYYY-MM-DD format.") from error
    if parsed_exam_date < date.today():
        raise ValueError("Exam date must be today or in the future.")
    if not isinstance(daily_minutes, int) or isinstance(daily_minutes, bool) or not 15 <= daily_minutes <= 480:
        raise ValueError("Study time must be between 15 and 480 minutes per day.")
    if not isinstance(topics, list) or not 1 <= len(topics) <= MAX_TOPICS:
        raise ValueError(f"Provide between 1 and {MAX_TOPICS} topics.")
    if any(not isinstance(topic, str) or not topic.strip() or len(topic) > 150 for topic in topics):
        raise ValueError("Each topic must be 1 to 150 characters.")

    return {
        "subject": subject.strip(),
        "examDate": exam_date,
        "dailyMinutes": daily_minutes,
        "topics": [topic.strip() for topic in topics],
    }


def generate_plan(api_key, request_data):
    response_schema = {
        "type": "OBJECT",
        "properties": {
            "sessions": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "date": {"type": "STRING"},
                        "topic": {"type": "STRING"},
                        "durationMinutes": {"type": "INTEGER"},
                    },
                    "required": ["date", "topic", "durationMinutes"],
                },
            },
        },
        "required": ["sessions"],
    }
    instructions = (
        "Create a realistic study schedule using only the supplied topic names. "
        "Distribute the topics across dates from today through the exam date, "
        "with no more than the supplied study minutes on any date. Use focused "
        "sessions between 15 and 120 minutes, combine topics only when useful, "
        "and schedule a short review before the exam if time allows. "
        "Return no more than 30 sessions. Do not invent calendar dates after the exam."
    )
    prompt = f"{instructions}\nStudy details:\n{json.dumps(request_data, ensure_ascii=False)}"
    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.3,
            "responseMimeType": "application/json",
            "responseSchema": response_schema,
        },
    }
    endpoint = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{quote(GEMINI_MODEL, safe='')}:generateContent?{urlencode({'key': api_key})}"
    )
    request = Request(
        endpoint,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=45) as response:
        result = json.loads(response.read())

    generated_text = result["candidates"][0]["content"]["parts"][0]["text"]
    parsed_result = json.loads(generated_text)
    sessions = parsed_result.get("sessions")
    if not isinstance(sessions, list) or not sessions or len(sessions) > MAX_TOPICS:
        raise ValueError("Expected between 1 and 30 sessions.")

    cleaned_sessions = []
    minutes_by_date = {}
    today = date.today()
    exam_date = date.fromisoformat(request_data["examDate"])
    allowed_topics = {topic.casefold() for topic in request_data["topics"]}
    for session in sessions:
        if not isinstance(session, dict):
            raise ValueError("A session was not an object.")
        date_text = session.get("date", "")
        if not isinstance(date_text, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_text):
            raise ValueError("A session date must use YYYY-MM-DD format.")
        session_date = date.fromisoformat(date_text)
        topic = session.get("topic")
        duration = session.get("durationMinutes")
        if session_date < today or session_date > exam_date:
            raise ValueError("A session date fell outside the requested exam window.")
        if not isinstance(topic, str) or not topic.strip() or len(topic) > 150:
            raise ValueError("A session has an invalid topic.")
        if topic.casefold() not in allowed_topics:
            raise ValueError("A session used a topic not provided in the request.")
        if not isinstance(duration, int) or isinstance(duration, bool) or not 15 <= duration <= 120:
            raise ValueError("A session duration must be between 15 and 120 minutes.")
        minutes_by_date[session_date] = minutes_by_date.get(session_date, 0) + duration
        if minutes_by_date[session_date] > request_data["dailyMinutes"]:
            raise ValueError("A day's scheduled study time exceeds the daily limit.")
        cleaned_sessions.append({
            "date": session_date.isoformat(),
            "topic": topic.strip(),
            "durationMinutes": duration,
        })

    return sorted(cleaned_sessions, key=lambda session: (session["date"], session["topic"].casefold()))


def read_provider_error(error):
    try:
        payload = json.loads(error.read())
        return payload.get("error", {}).get("message", "The provider rejected the request.")
    except (json.JSONDecodeError, UnicodeDecodeError, AttributeError):
        return "The provider rejected the request."


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), DaymarkHandler)
    print(f"Daymark is running at http://localhost:{PORT}/")
    print("Set GEMINI_API_KEY before starting to enable AI study plans.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Daymark.")
    finally:
        server.server_close()
