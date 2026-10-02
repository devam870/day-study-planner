"use strict";

const STORAGE_KEY = "daymark.tasks.v1";
const DELETED_EVENTS_KEY = "daymark.calendar-deletions.v1";
const STUDY_STORAGE_KEY = "daymark.study.v1";
const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const notice = document.querySelector("#notice");
let tasks = loadTasks();
let studyData = loadStudyData();
let activeFilter = "all";
let visibleMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let googleTokenClient = null;
let generatedStudyPlan = [];

const todayLabel = document.querySelector("#today-label");
if (todayLabel) {
  todayLabel.textContent = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric"
  }).format(new Date());
}

const taskForm = document.querySelector("#task-form");
if (taskForm) {
  taskForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const titleInput = document.querySelector("#task-title");
    const dateInput = document.querySelector("#task-date");
    addTask(titleInput.value, dateInput.value, taskForm, titleInput, "#task-link", "#task-note");
  });
}

const quickTaskForm = document.querySelector("#quick-task-form");
if (quickTaskForm) {
  quickTaskForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const titleInput = document.querySelector("#quick-task-title");
    const dateInput = document.querySelector("#quick-task-date");
    addTask(titleInput.value, dateInput.value, quickTaskForm, titleInput);
  });
}

initializeStudyTools();

const filters = document.querySelector(".filters");
if (filters) {
  filters.addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]");
    if (!button) return;

    activeFilter = button.dataset.filter;
    filters.querySelectorAll(".filter-button").forEach((filterButton) => {
      const isSelected = filterButton === button;
      filterButton.classList.toggle("is-selected", isSelected);
      filterButton.setAttribute("aria-pressed", String(isSelected));
    });
    renderTasks();
  });
}

const taskList = document.querySelector("#task-list");
if (taskList) taskList.addEventListener("click", handleTaskAction);

const upcomingList = document.querySelector("#upcoming-list");
if (upcomingList) upcomingList.addEventListener("click", handleTaskAction);

const clearCompletedButton = document.querySelector("#clear-completed");
if (clearCompletedButton) {
  clearCompletedButton.addEventListener("click", () => {
    const completedTasks = tasks.filter((task) => task.completed);
    const linkedEventCount = completedTasks.filter((task) => task.calendarEventId).length;
    if (linkedEventCount && !window.confirm(`Clear completed tasks and delete ${linkedEventCount} linked Google Calendar ${linkedEventCount === 1 ? "event" : "events"} on your next sync?`)) return;
    removeTasks(completedTasks);
  });
}

const clearAllButton = document.querySelector("#clear-all-tasks");
if (clearAllButton) {
  clearAllButton.addEventListener("click", () => {
    if (!tasks.length) {
      showNotice("There are no tasks to clear.");
      return;
    }
    const linkedEventCount = tasks.filter((task) => task.calendarEventId).length;
    const calendarWarning = linkedEventCount
      ? ` ${linkedEventCount} linked Google Calendar ${linkedEventCount === 1 ? "event will" : "events will"} also be deleted on your next sync.`
      : "";
    if (!window.confirm(`Delete all tasks saved in this browser?${calendarWarning} This cannot be undone.`)) return;

    if (removeTasks(tasks)) {
      const calendarMessage = linkedEventCount
        ? ` ${linkedEventCount} linked Google Calendar ${linkedEventCount === 1 ? "event is" : "events are"} queued for deletion on your next sync.`
        : "";
      showNotice(`All tasks were cleared.${calendarMessage}`);
    }
  });
}

const googleSyncButton = document.querySelector("#google-sync-button");
if (googleSyncButton) {
  googleSyncButton.addEventListener("click", connectAndSyncGoogleCalendar);
  if (!window.DAYMARK_GOOGLE_CLIENT_ID) {
    googleSyncButton.disabled = true;
    googleSyncButton.title = "Add your Google OAuth Client ID to google-config.js first.";
  }
}

const previousMonthButton = document.querySelector("#previous-month");
if (previousMonthButton) {
  previousMonthButton.addEventListener("click", () => {
    visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() - 1, 1);
    renderCalendar();
  });
}

const nextMonthButton = document.querySelector("#next-month");
if (nextMonthButton) {
  nextMonthButton.addEventListener("click", () => {
    visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 1);
    renderCalendar();
  });
}

const thisMonthButton = document.querySelector("#this-month");
if (thisMonthButton) {
  thisMonthButton.addEventListener("click", () => {
    visibleMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    renderCalendar();
  });
}

function addTask(rawTitle, dueDate, form, titleInput, linkSelector, noteSelector) {
  const title = rawTitle.trim();
  if (!title) {
    titleInput.focus();
    return;
  }

  const linkInput = linkSelector ? document.querySelector(linkSelector) : null;
  const noteInput = noteSelector ? document.querySelector(noteSelector) : null;
  const link = linkInput ? linkInput.value.trim() : "";
  const note = noteInput ? noteInput.value.trim() : "";
  if (link && !isWebUrl(link)) {
    linkInput.setCustomValidity("Use a web link that starts with https:// or http://.");
    linkInput.reportValidity();
    linkInput.addEventListener("input", () => linkInput.setCustomValidity(""), { once: true });
    return;
  }

  const task = {
    id: createId(),
    title,
    dueDate,
    completed: false,
    createdAt: Date.now(),
    ...(link ? { link } : {}),
    ...(note ? { note } : {})
  };
  tasks.unshift(task);

  if (saveTasks()) {
    form.reset();
    titleInput.focus();
    render();
  } else {
    tasks.shift();
  }
}

function handleTaskAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const task = tasks.find((item) => item.id === button.dataset.id);
  if (!task) return;
  const previousTasks = tasks.map((item) => ({ ...item }));

  if (button.dataset.action === "toggle") {
    task.completed = !task.completed;
  } else if (button.dataset.action === "delete") {
    if (task.calendarEventId && !window.confirm("Delete this task and its linked Google Calendar event on your next sync?")) return;
    removeTasks([task]);
    return;
  }

  if (saveTasks()) render();
  else tasks = previousTasks;
}

function removeTasks(tasksToRemove) {
  if (!tasksToRemove.length) return false;
  const previousTasks = tasks;
  let previousDeletedEventIds;
  try {
    previousDeletedEventIds = loadDeletedEventIds();
  } catch {
    return false;
  }
  const linkedEventCount = tasksToRemove.filter((task) => task.calendarEventId).length;
  const removedIds = new Set(tasksToRemove.map((task) => task.id));
  tasks = tasks.filter((task) => !removedIds.has(task.id));

  try {
    const deletedEventIds = [...new Set([
      ...previousDeletedEventIds,
      ...tasksToRemove.map((task) => task.calendarEventId).filter(Boolean)
    ])];
    localStorage.setItem(DELETED_EVENTS_KEY, JSON.stringify(deletedEventIds));
    if (saveTasks()) {
      render();
      if (linkedEventCount) {
        const calendarMessage = linkedEventCount === 1
          ? "Its linked Google Calendar event is queued for deletion on your next sync."
          : `${linkedEventCount} linked Google Calendar events are queued for deletion on your next sync.`;
        showNotice(calendarMessage);
      }
      return true;
    }
  } catch (error) {
    showNotice(`Your changes could not be saved: ${error.message}`);
  }

  tasks = previousTasks;
  try {
    localStorage.setItem(DELETED_EVENTS_KEY, JSON.stringify(previousDeletedEventIds));
  } catch (error) {
    showNotice(`Your Google Calendar deletion queue could not be restored: ${error.message}`);
  }
  return false;
}

function loadTasks() {
  try {
    const storedTasks = localStorage.getItem(STORAGE_KEY);
    if (!storedTasks) return [];

    const parsedTasks = JSON.parse(storedTasks);
    if (!Array.isArray(parsedTasks) || !parsedTasks.every(isValidTask)) {
      throw new Error("Stored task data has an invalid format.");
    }
    return parsedTasks;
  } catch (error) {
    showNotice(`Your saved tasks could not be loaded: ${error.message}`);
    return [];
  }
}

function isValidTask(task) {
  return task !== null
    && typeof task === "object"
    && typeof task.id === "string"
    && typeof task.title === "string"
    && typeof task.completed === "boolean"
    && (typeof task.dueDate === "string" || task.dueDate === "")
    && (task.calendarEventId === undefined || typeof task.calendarEventId === "string")
    && (task.link === undefined || typeof task.link === "string")
    && (task.note === undefined || typeof task.note === "string");
}

function saveTasks() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    hideNotice();
    return true;
  } catch (error) {
    showNotice(`Your changes could not be saved: ${error.message}`);
    return false;
  }
}

function createId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function nextDateKey(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return dateKey(new Date(year, month - 1, day + 1));
}

function formatDueDate(dateString, options = { month: "short", day: "numeric", year: "numeric" }) {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, options).format(new Date(year, month - 1, day));
}

function render() {
  renderDashboard();
  renderTasks();
  renderCalendar();
}

function renderDashboard() {
  const remainingCount = tasks.filter((task) => !task.completed).length;
  const completedCount = tasks.length - remainingCount;
  const today = dateKey(new Date());
  const dueTodayCount = tasks.filter((task) => !task.completed && task.dueDate === today).length;

  const remainingElement = document.querySelector("#remaining-count");
  const completedElement = document.querySelector("#completed-count");
  const dueTodayElement = document.querySelector("#due-today-count");
  if (remainingElement) remainingElement.textContent = remainingCount;
  if (completedElement) completedElement.textContent = completedCount;
  if (dueTodayElement) dueTodayElement.textContent = dueTodayCount;

  if (!upcomingList) return;
  const upcomingTasks = tasks
    .filter((task) => !task.completed)
    .sort((first, second) => {
      if (!first.dueDate) return second.dueDate ? 1 : 0;
      if (!second.dueDate) return -1;
      return first.dueDate.localeCompare(second.dueDate);
    })
    .slice(0, 5);

  upcomingList.replaceChildren(...upcomingTasks.map(createTaskElement));
  document.querySelector("#upcoming-empty").hidden = upcomingTasks.length > 0;
}

function renderTasks() {
  if (!taskList) return;
  const visibleTasks = tasks.filter((task) => {
    if (activeFilter === "active") return !task.completed;
    if (activeFilter === "completed") return task.completed;
    return true;
  });
  const remainingCount = tasks.filter((task) => !task.completed).length;

  taskList.replaceChildren(...visibleTasks.map(createTaskElement));
  document.querySelector("#empty-state").hidden = visibleTasks.length > 0;
  document.querySelector("#task-count").textContent = `${remainingCount} ${remainingCount === 1 ? "task" : "tasks"} left`;
  clearCompletedButton.hidden = !tasks.some((task) => task.completed);
  document.querySelector("#footer-message").textContent = remainingCount === 0 && tasks.length > 0
    ? "You made it happen. Nice work."
    : "Small steps count, too.";
}

function createTaskElement(task) {
  const item = document.createElement("li");
  item.className = `task-item${task.completed ? " is-completed" : ""}`;

  const checkButton = document.createElement("button");
  checkButton.className = "task-check";
  checkButton.type = "button";
  checkButton.dataset.action = "toggle";
  checkButton.dataset.id = task.id;
  checkButton.setAttribute("aria-pressed", String(task.completed));
  checkButton.setAttribute("aria-label", `${task.completed ? "Mark as to do" : "Complete"}: ${task.title}`);
  checkButton.textContent = "✓";

  const content = document.createElement("div");
  content.className = "task-content";

  const title = document.createElement("div");
  title.className = "task-title";
  title.textContent = task.title;
  content.append(title);

  if (task.dueDate) {
    const dueDate = document.createElement("time");
    dueDate.className = "task-date";
    dueDate.dateTime = task.dueDate;
    dueDate.textContent = `Due ${formatDueDate(task.dueDate)}`;
    if (!task.completed && task.dueDate < dateKey(new Date())) {
      dueDate.classList.add("is-overdue");
    }
    content.append(dueDate);
  }

  if (task.note) {
    const note = document.createElement("span");
    note.className = "task-note";
    note.textContent = task.note;
    content.append(note);
  }

  if (task.link && isWebUrl(task.link)) {
    const link = document.createElement("a");
    link.className = "task-resource-link";
    link.href = task.link;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open resource ↗";
    content.append(link);
  }

  const deleteButton = document.createElement("button");
  deleteButton.className = "delete-button";
  deleteButton.type = "button";
  deleteButton.dataset.action = "delete";
  deleteButton.dataset.id = task.id;
  deleteButton.setAttribute("aria-label", `${task.calendarEventId ? "Delete task and linked Google Calendar event" : "Delete"}: ${task.title}`);
  if (task.calendarEventId) {
    deleteButton.title = "The linked Google Calendar event will be deleted on your next sync.";
  }
  deleteButton.textContent = "×";

  item.append(checkButton, content, deleteButton);
  return item;
}

function renderCalendar() {
  const grid = document.querySelector("#calendar-grid");
  if (!grid) return;

  const monthTitle = document.querySelector("#month-title");
  monthTitle.textContent = new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric"
  }).format(visibleMonth);

  const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const cells = weekdays.map((weekday) => {
    const heading = document.createElement("div");
    heading.className = "weekday";
    heading.setAttribute("role", "columnheader");
    heading.textContent = weekday;
    return heading;
  });

  const firstOfMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1);
  const offset = (firstOfMonth.getDay() + 6) % 7;
  const daysInMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 0).getDate();
  const cellCount = Math.ceil((offset + daysInMonth) / 7) * 7;
  const today = dateKey(new Date());

  for (let index = 0; index < cellCount; index += 1) {
    const date = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), index - offset + 1);
    const key = dateKey(date);
    const dayTasks = tasks.filter((task) => task.dueDate === key);
    const cell = document.createElement("div");
    cell.className = "calendar-day";
    cell.setAttribute("role", "gridcell");
    if (date.getMonth() !== visibleMonth.getMonth()) cell.classList.add("is-outside");
    if (key === today) cell.classList.add("is-today");

    const number = document.createElement("span");
    number.className = "day-number";
    number.textContent = date.getDate();
    cell.append(number);

    if (dayTasks.length) {
      const taskGroup = document.createElement("ul");
      taskGroup.className = "calendar-day-tasks";
      dayTasks.slice(0, 2).forEach((task) => {
        const taskLabel = document.createElement("li");
        taskLabel.className = `calendar-task${task.completed ? " is-completed" : ""}`;
        taskLabel.textContent = task.title;
        taskGroup.append(taskLabel);
      });
      if (dayTasks.length > 2) {
        const more = document.createElement("li");
        more.className = "calendar-more";
        more.textContent = `+${dayTasks.length - 2} more`;
        taskGroup.append(more);
      }
      cell.append(taskGroup);
    }
    cells.push(cell);
  }

  grid.replaceChildren(...cells);
}

function isWebUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function createStudyDefaults() {
  return {
    exams: [],
    timer: { mode: "study", remainingMs: 25 * 60 * 1000, runningUntil: null, subject: "" },
    sessions: [],
    timetable: [],
    syllabus: []
  };
}

function loadStudyData() {
  const defaults = createStudyDefaults();
  try {
    const stored = localStorage.getItem(STUDY_STORAGE_KEY);
    if (!stored) return defaults;

    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object"
      || !Array.isArray(parsed.exams)
      || !Array.isArray(parsed.sessions)
      || !Array.isArray(parsed.timetable)
      || !Array.isArray(parsed.syllabus)
      || !parsed.timer || typeof parsed.timer !== "object") {
      throw new Error("Saved study planner data has an invalid format.");
    }
    if (!parsed.exams.every((exam) => exam && typeof exam.id === "string" && typeof exam.name === "string" && typeof exam.date === "string")
      || !parsed.sessions.every((session) => session && typeof session.subject === "string" && Number.isFinite(session.minutes) && typeof session.date === "string")
      || !parsed.timetable.every((entry) => entry && typeof entry.id === "string" && typeof entry.title === "string" && Number.isInteger(entry.day) && typeof entry.start === "string" && typeof entry.end === "string")
      || !parsed.syllabus.every((subject) => subject && typeof subject.id === "string" && typeof subject.name === "string" && Array.isArray(subject.chapters))) {
      throw new Error("Saved study planner data contains invalid entries.");
    }

    return {
      exams: parsed.exams,
      sessions: parsed.sessions,
      timetable: parsed.timetable,
      syllabus: parsed.syllabus,
      timer: {
        mode: parsed.timer.mode === "break" ? "break" : "study",
        remainingMs: Number.isFinite(parsed.timer.remainingMs) ? Math.max(0, parsed.timer.remainingMs) : defaults.timer.remainingMs,
        runningUntil: Number.isFinite(parsed.timer.runningUntil) ? parsed.timer.runningUntil : null,
        subject: typeof parsed.timer.subject === "string" ? parsed.timer.subject : ""
      }
    };
  } catch (error) {
    showStudyNotice(`Your study planner could not be loaded: ${error.message}`);
    return defaults;
  }
}

function saveStudyData() {
  try {
    localStorage.setItem(STUDY_STORAGE_KEY, JSON.stringify(studyData));
    hideStudyNotice();
    return true;
  } catch (error) {
    showStudyNotice(`Your study planner changes could not be saved: ${error.message}`);
    return false;
  }
}

function updateStudyData(update) {
  const previous = JSON.stringify(studyData);
  update();
  if (saveStudyData()) {
    renderStudy();
    return true;
  }
  studyData = JSON.parse(previous);
  renderStudy();
  return false;
}

function initializeStudyTools() {
  if (document.body.dataset.page !== "study") return;

  const studyToday = document.querySelector("#study-today-label");
  studyToday.textContent = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric"
  }).format(new Date());

  const aiPlanForm = document.querySelector("#ai-plan-form");
  aiPlanForm.addEventListener("submit", generateAiStudyPlan);
  document.querySelector("#add-plan-to-tasks").addEventListener("click", addGeneratedPlanToTasks);

  document.querySelector("#exam-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = document.querySelector("#exam-name").value.trim();
    const date = document.querySelector("#exam-date").value;
    if (!name || !date) return;
    if (updateStudyData(() => {
      studyData.exams.push({ id: createId(), name, date });
      studyData.exams.sort((first, second) => first.date.localeCompare(second.date));
    })) event.currentTarget.reset();
  });

  document.querySelector("#exam-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-delete-exam]");
    if (!button) return;
    updateStudyData(() => {
      studyData.exams = studyData.exams.filter((exam) => exam.id !== button.dataset.deleteExam);
    });
  });

  document.querySelector("#timer-subject").addEventListener("input", (event) => {
    studyData.timer.subject = event.currentTarget.value.trim();
    saveStudyData();
  });
  document.querySelector("#timer-start").addEventListener("click", togglePomodoro);
  document.querySelector("#timer-reset").addEventListener("click", resetPomodoro);
  window.setInterval(tickPomodoro, 250);

  document.querySelector("#timetable-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const title = document.querySelector("#schedule-title").value.trim();
    const subject = document.querySelector("#schedule-subject").value.trim();
    const day = Number(document.querySelector("#schedule-day").value);
    const start = document.querySelector("#schedule-start").value;
    const end = document.querySelector("#schedule-end").value;
    if (!title || !start || !end) return;
    if (end <= start) {
      showStudyNotice("The end time must be later than the start time.");
      return;
    }
    if (updateStudyData(() => {
      studyData.timetable.push({ id: createId(), title, subject, day, start, end });
      studyData.timetable.sort((first, second) => first.day - second.day || first.start.localeCompare(second.start));
    })) event.currentTarget.reset();
  });

  document.querySelector("#timetable-grid").addEventListener("click", (event) => {
    const button = event.target.closest("[data-delete-block]");
    if (!button) return;
    updateStudyData(() => {
      studyData.timetable = studyData.timetable.filter((entry) => entry.id !== button.dataset.deleteBlock);
    });
  });

  document.querySelector("#syllabus-subject-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const nameInput = document.querySelector("#syllabus-subject-name");
    const name = nameInput.value.trim();
    if (!name) return;
    if (updateStudyData(() => {
      studyData.syllabus.push({ id: createId(), name, chapters: [] });
    })) event.currentTarget.reset();
  });

  document.querySelector("#syllabus-list").addEventListener("submit", (event) => {
    const form = event.target.closest("[data-chapter-form]");
    if (!form) return;
    event.preventDefault();
    const input = form.querySelector("input");
    const title = input.value.trim();
    if (!title) return;
    updateStudyData(() => {
      const subject = studyData.syllabus.find((item) => item.id === form.dataset.subjectId);
      if (subject) subject.chapters.push({ id: createId(), title, completed: false });
    });
  });

  document.querySelector("#syllabus-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-syllabus-action]");
    if (!button) return;
    updateStudyData(() => {
      const subject = studyData.syllabus.find((item) => item.id === button.dataset.subjectId);
      if (!subject) return;
      if (button.dataset.syllabusAction === "delete-subject") {
        studyData.syllabus = studyData.syllabus.filter((item) => item.id !== subject.id);
      } else if (button.dataset.syllabusAction === "toggle-chapter") {
        const chapter = subject.chapters.find((item) => item.id === button.dataset.chapterId);
        if (chapter) chapter.completed = !chapter.completed;
      } else if (button.dataset.syllabusAction === "delete-chapter") {
        subject.chapters = subject.chapters.filter((item) => item.id !== button.dataset.chapterId);
      }
    });
  });

  renderStudy();
}

async function generateAiStudyPlan(event) {
  event.preventDefault();
  const subject = document.querySelector("#ai-subject").value.trim();
  const examDate = document.querySelector("#ai-exam-date").value;
  const dailyMinutes = Number(document.querySelector("#ai-daily-minutes").value);
  const topics = document.querySelector("#ai-chapters").value
    .split(/\r?\n/)
    .map((topic) => topic.trim())
    .filter(Boolean);

  if (!subject || !examDate || topics.length === 0 || topics.length > 30) {
    showStudyNotice("Enter a subject, exam date, and between 1 and 30 topics.");
    return;
  }
  if (!Number.isInteger(dailyMinutes) || dailyMinutes < 15 || dailyMinutes > 480) {
    showStudyNotice("Choose between 15 and 480 study minutes per day.");
    return;
  }
  if (examDate < dateKey(new Date())) {
    showStudyNotice("Choose today or a future exam date.");
    return;
  }

  const submitButton = document.querySelector("#generate-plan");
  submitButton.disabled = true;
  submitButton.textContent = "Building your plan…";
  hideStudyNotice();

  try {
    const response = await fetch("/api/study-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject, examDate, dailyMinutes, topics })
    });
    let data;
    try {
      data = await response.json();
    } catch (error) {
      throw new Error(`The planner server returned an unreadable response: ${error.message}`);
    }
    if (!response.ok) {
      throw new Error(data.error || `The planner server returned HTTP ${response.status}.`);
    }
    if (!Array.isArray(data.sessions) || !data.sessions.length) {
      throw new Error("Gemini did not return any study sessions. Try adding more time before the exam.");
    }
    generatedStudyPlan = data.sessions;
    renderGeneratedPlan();
  } catch (error) {
    showStudyNotice(`Could not generate a plan: ${error.message}. Start the app with python server.py and confirm GEMINI_API_KEY is set.`);
  } finally {
    submitButton.disabled = false;
    submitButton.innerHTML = 'Generate study plan <span aria-hidden="true">✦</span>';
  }
}

function renderGeneratedPlan() {
  const planContainer = document.querySelector("#generated-plan");
  const planList = document.querySelector("#generated-plan-list");
  planList.replaceChildren(...generatedStudyPlan.map((session) => {
    const row = document.createElement("article");
    row.className = "generated-session";
    const details = document.createElement("div");
    const topic = document.createElement("strong");
    topic.textContent = session.topic;
    const date = document.createElement("time");
    date.dateTime = session.date;
    date.textContent = formatDueDate(session.date);
    details.append(topic, date);
    const duration = document.createElement("span");
    duration.className = "generated-duration";
    duration.textContent = `${session.durationMinutes} min`;
    row.append(details, duration);
    return row;
  }));
  planContainer.hidden = generatedStudyPlan.length === 0;
  document.querySelector("#add-plan-to-tasks").disabled = generatedStudyPlan.length === 0;
}

function addGeneratedPlanToTasks() {
  if (!generatedStudyPlan.length) return;
  const existingTasks = tasks.map((task) => ({ ...task }));
  const newTasks = generatedStudyPlan.map((session) => ({
    id: createId(),
    title: `Study: ${session.topic}`,
    dueDate: session.date,
    completed: false,
    createdAt: Date.now(),
    note: `${session.durationMinutes}-minute ${document.querySelector("#ai-subject").value.trim()} study session`
  }));
  tasks = [...newTasks, ...tasks];
  if (!saveTasks()) {
    tasks = existingTasks;
    return;
  }
  generatedStudyPlan = [];
  renderGeneratedPlan();
  showStudyNotice(`${newTasks.length} study ${newTasks.length === 1 ? "session was" : "sessions were"} added to your Tasks page.`);
}

function togglePomodoro() {
  const previousTimer = { ...studyData.timer };
  if (studyData.timer.runningUntil) {
    studyData.timer.remainingMs = Math.max(0, studyData.timer.runningUntil - Date.now());
    studyData.timer.runningUntil = null;
  } else {
    if (studyData.timer.mode === "study" && !studyData.timer.subject.trim()) {
      showStudyNotice("Enter a subject before starting a study session.");
      document.querySelector("#timer-subject").focus();
      return;
    }
    studyData.timer.runningUntil = Date.now() + studyData.timer.remainingMs;
  }
  if (saveStudyData()) renderPomodoro();
  else {
    studyData.timer = previousTimer;
    renderPomodoro();
  }
}

function resetPomodoro() {
  const previousTimer = { ...studyData.timer };
  studyData.timer.runningUntil = null;
  studyData.timer.remainingMs = studyData.timer.mode === "study" ? 25 * 60 * 1000 : 5 * 60 * 1000;
  if (saveStudyData()) renderPomodoro();
  else {
    studyData.timer = previousTimer;
    renderPomodoro();
  }
}

function tickPomodoro() {
  if (document.body.dataset.page !== "study" || !studyData.timer.runningUntil) return;
  if (studyData.timer.runningUntil - Date.now() > 0) {
    renderPomodoro();
    return;
  }

  const previousStudyData = JSON.stringify(studyData);
  if (studyData.timer.mode === "study") {
    studyData.sessions.unshift({
      id: createId(),
      subject: studyData.timer.subject.trim(),
      minutes: 25,
      date: dateKey(new Date())
    });
    studyData.timer.mode = "break";
    studyData.timer.remainingMs = 5 * 60 * 1000;
  } else {
    studyData.timer.mode = "study";
    studyData.timer.remainingMs = 25 * 60 * 1000;
  }
  studyData.timer.runningUntil = null;
  if (saveStudyData()) {
    renderStudy();
    showStudyNotice(studyData.timer.mode === "break"
      ? "Focus session complete. Your 5-minute break is ready."
      : "Break complete. Ready for another 25-minute focus session?");
  } else {
    studyData = JSON.parse(previousStudyData);
    renderStudy();
  }
}

function renderStudy() {
  if (document.body.dataset.page !== "study") return;
  renderExams();
  renderPomodoro();
  renderTimetable();
  renderSyllabus();
}

function renderExams() {
  const list = document.querySelector("#exam-list");
  const today = new Date();
  const todayDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const sortedExams = [...studyData.exams].sort((first, second) => first.date.localeCompare(second.date));
  list.replaceChildren(...sortedExams.map((exam) => {
    const [year, month, day] = exam.date.split("-").map(Number);
    const examDate = new Date(year, month - 1, day);
    const daysLeft = Math.round((examDate - todayDate) / 86400000);
    const card = document.createElement("article");
    card.className = "exam-card";
    const detail = document.createElement("div");
    detail.className = "exam-card-detail";
    const name = document.createElement("h3");
    name.textContent = exam.name;
    const date = document.createElement("time");
    date.dateTime = exam.date;
    date.textContent = formatDueDate(exam.date);
    detail.append(name, date);
    const countdown = document.createElement("p");
    countdown.className = `exam-countdown${daysLeft < 0 ? " is-past" : ""}`;
    countdown.textContent = daysLeft < 0
      ? `${Math.abs(daysLeft)} ${Math.abs(daysLeft) === 1 ? "day" : "days"} ago`
      : daysLeft === 0 ? "Today!" : `${daysLeft} ${daysLeft === 1 ? "day" : "days"} left`;
    const remove = document.createElement("button");
    remove.className = "study-delete-button";
    remove.type = "button";
    remove.dataset.deleteExam = exam.id;
    remove.setAttribute("aria-label", `Delete exam: ${exam.name}`);
    remove.textContent = "×";
    card.append(detail, countdown, remove);
    return card;
  }));
  document.querySelector("#exam-empty").hidden = sortedExams.length > 0;
}

function renderPomodoro() {
  const timer = studyData.timer;
  const remaining = timer.runningUntil ? Math.max(0, timer.runningUntil - Date.now()) : timer.remainingMs;
  const totalSeconds = Math.ceil(remaining / 1000);
  document.querySelector("#timer-display").textContent = `${String(Math.floor(totalSeconds / 60)).padStart(2, "0")}:${String(totalSeconds % 60).padStart(2, "0")}`;
  document.querySelector("#timer-mode").textContent = timer.mode === "study" ? "Study session · 25 min" : "Short break · 5 min";
  document.querySelector("#timer-caption").textContent = timer.mode === "study"
    ? "A focused 25-minute study session."
    : "Step away for a restorative 5-minute break.";
  const startButton = document.querySelector("#timer-start");
  startButton.textContent = timer.runningUntil ? "Pause" : timer.mode === "study" ? "Start focus" : "Start break";
  document.querySelector("#timer-subject").value = timer.subject;
  document.querySelector("#timer-subject").disabled = timer.mode === "break" || Boolean(timer.runningUntil);

  const totalMinutes = studyData.sessions.reduce((total, session) => total + session.minutes, 0);
  document.querySelector("#timer-log-summary").textContent = totalMinutes
    ? `${totalMinutes} minutes logged across ${studyData.sessions.length} completed focus ${studyData.sessions.length === 1 ? "session" : "sessions"}.`
    : "No study sessions logged yet. Complete a 25-minute focus session to log time.";

  const minutesBySubject = new Map();
  studyData.sessions.forEach((session) => {
    minutesBySubject.set(session.subject, (minutesBySubject.get(session.subject) || 0) + session.minutes);
  });
  const subjectTotals = document.querySelector("#subject-time-totals");
  subjectTotals.replaceChildren(...[...minutesBySubject.entries()].map(([subjectName, minutes]) => {
    const total = document.createElement("div");
    total.className = "subject-time-total";
    const name = document.createElement("span");
    name.textContent = subjectName;
    const time = document.createElement("strong");
    time.textContent = `${minutes} min`;
    total.append(name, time);
    return total;
  }));

  const list = document.querySelector("#study-log-list");
  const recent = studyData.sessions.slice(0, 8);
  list.replaceChildren(...recent.map((session) => {
    const row = document.createElement("div");
    row.className = "study-log-row";
    const subject = document.createElement("span");
    subject.textContent = session.subject;
    const duration = document.createElement("span");
    duration.textContent = `${session.minutes} min · ${formatDueDate(session.date, { month: "short", day: "numeric" })}`;
    row.append(subject, duration);
    return row;
  }));
}

function renderTimetable() {
  const grid = document.querySelector("#timetable-grid");
  const weekdays = [
    { value: 1, name: "Monday" }, { value: 2, name: "Tuesday" }, { value: 3, name: "Wednesday" },
    { value: 4, name: "Thursday" }, { value: 5, name: "Friday" }, { value: 6, name: "Saturday" },
    { value: 0, name: "Sunday" }
  ];
  const entries = [...studyData.timetable].sort((first, second) => first.day - second.day || first.start.localeCompare(second.start));
  grid.replaceChildren(...weekdays.map((weekday) => {
    const day = document.createElement("section");
    day.className = "timetable-day";
    const heading = document.createElement("h3");
    heading.textContent = weekday.name;
    day.append(heading);
    const dayEntries = entries.filter((entry) => entry.day === weekday.value);
    if (!dayEntries.length) {
      const empty = document.createElement("p");
      empty.className = "timetable-day-empty";
      empty.textContent = "No blocks";
      day.append(empty);
    }
    dayEntries.forEach((entry) => {
      const block = document.createElement("article");
      block.className = "timetable-block";
      const title = document.createElement("strong");
      title.textContent = entry.title;
      const time = document.createElement("time");
      time.textContent = `${entry.start}–${entry.end}`;
      const details = document.createElement("div");
      details.append(title, time);
      if (entry.subject) {
        const subject = document.createElement("span");
        subject.textContent = entry.subject;
        details.append(subject);
      }
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "study-delete-button";
      remove.dataset.deleteBlock = entry.id;
      remove.setAttribute("aria-label", `Delete timetable block: ${entry.title}`);
      remove.textContent = "×";
      block.append(details, remove);
      day.append(block);
    });
    return day;
  }));
  document.querySelector("#timetable-empty").hidden = entries.length > 0;
  grid.hidden = entries.length === 0;
}

function renderSyllabus() {
  const list = document.querySelector("#syllabus-list");
  list.replaceChildren(...studyData.syllabus.map((subject) => {
    const card = document.createElement("article");
    card.className = "syllabus-card";
    const heading = document.createElement("div");
    heading.className = "syllabus-heading";
    const title = document.createElement("h3");
    title.textContent = subject.name;
    const completed = subject.chapters.filter((chapter) => chapter.completed).length;
    const progressText = document.createElement("span");
    progressText.textContent = `${completed}/${subject.chapters.length} chapters`;
    heading.append(title, progressText);

    const progress = document.createElement("progress");
    progress.max = subject.chapters.length || 1;
    progress.value = completed;
    progress.setAttribute("aria-label", `${subject.name} syllabus progress`);

    const removeSubject = document.createElement("button");
    removeSubject.type = "button";
    removeSubject.className = "study-delete-button";
    removeSubject.dataset.syllabusAction = "delete-subject";
    removeSubject.dataset.subjectId = subject.id;
    removeSubject.setAttribute("aria-label", `Delete subject: ${subject.name}`);
    removeSubject.textContent = "×";
    heading.append(removeSubject);

    const chapterList = document.createElement("ul");
    chapterList.className = "chapter-list";
    subject.chapters.forEach((chapter) => {
      const row = document.createElement("li");
      row.className = `chapter-row${chapter.completed ? " is-completed" : ""}`;
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "chapter-toggle";
      toggle.dataset.syllabusAction = "toggle-chapter";
      toggle.dataset.subjectId = subject.id;
      toggle.dataset.chapterId = chapter.id;
      toggle.setAttribute("aria-pressed", String(chapter.completed));
      toggle.setAttribute("aria-label", `${chapter.completed ? "Mark incomplete" : "Mark complete"}: ${chapter.title}`);
      toggle.textContent = chapter.completed ? "✓" : "";
      const name = document.createElement("span");
      name.textContent = chapter.title;
      const removeChapter = document.createElement("button");
      removeChapter.type = "button";
      removeChapter.className = "chapter-remove";
      removeChapter.dataset.syllabusAction = "delete-chapter";
      removeChapter.dataset.subjectId = subject.id;
      removeChapter.dataset.chapterId = chapter.id;
      removeChapter.setAttribute("aria-label", `Delete chapter: ${chapter.title}`);
      removeChapter.textContent = "×";
      row.append(toggle, name, removeChapter);
      chapterList.append(row);
    });

    const addChapter = document.createElement("form");
    addChapter.className = "chapter-form";
    addChapter.dataset.chapterForm = "";
    addChapter.dataset.subjectId = subject.id;
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = `Add a ${subject.name} chapter`;
    input.maxLength = 100;
    input.required = true;
    input.setAttribute("aria-label", `New chapter for ${subject.name}`);
    const button = document.createElement("button");
    button.type = "submit";
    button.textContent = "Add chapter";
    addChapter.append(input, button);
    card.append(heading, progress, chapterList, addChapter);
    return card;
  }));
  document.querySelector("#syllabus-empty").hidden = studyData.syllabus.length > 0;
}

function showStudyNotice(message) {
  const studyNotice = document.querySelector("#study-notice");
  if (!studyNotice) {
    showNotice(message);
    return;
  }
  studyNotice.textContent = message;
  studyNotice.hidden = false;
}

function hideStudyNotice() {
  const studyNotice = document.querySelector("#study-notice");
  if (!studyNotice) return;
  studyNotice.textContent = "";
  studyNotice.hidden = true;
}

function loadDeletedEventIds() {
  try {
    const storedIds = localStorage.getItem(DELETED_EVENTS_KEY);
    if (!storedIds) return [];
    const parsedIds = JSON.parse(storedIds);
    if (!Array.isArray(parsedIds) || !parsedIds.every((id) => typeof id === "string")) {
      throw new Error("The saved Google Calendar deletion queue has an invalid format.");
    }
    return parsedIds;
  } catch (error) {
    showNotice(`Your Google Calendar deletion queue could not be loaded: ${error.message}`);
    throw error;
  }
}

function connectAndSyncGoogleCalendar() {
  if (!window.DAYMARK_GOOGLE_CLIENT_ID) {
    showNotice("Add your Google OAuth Client ID to google-config.js before connecting.");
    return;
  }
  if (!window.google || !window.google.accounts || !window.google.accounts.oauth2) {
    showNotice("Google sign-in did not load. Check your internet connection and try again.");
    return;
  }

  const status = document.querySelector("#google-sync-status");
  googleSyncButton.disabled = true;
  status.textContent = "Waiting for Google sign-in…";

  try {
    googleTokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: window.DAYMARK_GOOGLE_CLIENT_ID,
      scope: GOOGLE_CALENDAR_SCOPE,
      callback: async (response) => {
        if (response.error || !response.access_token) {
          googleSyncButton.disabled = false;
          status.textContent = "Google Calendar is not connected.";
          showNotice(`Google sign-in failed: ${response.error_description || response.error || "No access token was returned."}`);
          return;
        }

        try {
          await syncGoogleCalendar(response.access_token);
          status.textContent = "Google Calendar synced just now. Access is kept in memory only.";
        } catch (error) {
          status.textContent = "Google Calendar sync did not finish.";
          showNotice(`Google Calendar sync failed: ${error.message}`);
        } finally {
          googleSyncButton.disabled = false;
        }
      },
      error_callback: (error) => {
        googleSyncButton.disabled = false;
        status.textContent = "Google Calendar is not connected.";
        showNotice(`Google sign-in could not start: ${error.message || error.type}`);
      }
    });
    googleTokenClient.requestAccessToken({ prompt: "" });
  } catch (error) {
    googleSyncButton.disabled = false;
    status.textContent = "Google Calendar is not connected.";
    showNotice(`Google sign-in could not start: ${error.message}`);
  }
}

async function syncGoogleCalendar(accessToken) {
  const events = await fetchGoogleEvents(accessToken);
  const changedTaskIds = new Set();
  const previousTasks = tasks.map((task) => ({ ...task }));
  const pendingDeletionIds = new Set(loadDeletedEventIds());

  for (const event of events) {
    if (!event.id) continue;
    if (pendingDeletionIds.has(event.id)) continue;
    const existingTask = tasks.find((task) => task.calendarEventId === event.id);

    if (event.status === "cancelled") {
      if (existingTask) {
        tasks = tasks.filter((task) => task.id !== existingTask.id);
        changedTaskIds.add(existingTask.id);
      }
      continue;
    }

    const startDate = event.start && (event.start.date || event.start.dateTime);
    if (!existingTask || !event.summary || !startDate) continue;
    existingTask.title = event.summary;
    existingTask.dueDate = startDate.slice(0, 10);
    changedTaskIds.add(existingTask.id);
  }

  for (const event of events) {
    if (!event.id || event.status === "cancelled" || !event.summary) continue;
    if (pendingDeletionIds.has(event.id)) continue;
    const startDate = event.start && (event.start.date || event.start.dateTime);
    if (!startDate || tasks.some((task) => task.calendarEventId === event.id)) continue;
    tasks.push({
      id: createId(),
      title: event.summary,
      dueDate: startDate.slice(0, 10),
      completed: false,
      createdAt: Date.now(),
      calendarEventId: event.id
    });
    changedTaskIds.add(tasks[tasks.length - 1].id);
  }

  if (changedTaskIds.size && !saveTasks()) {
    tasks = previousTasks;
    throw new Error("Calendar events were fetched, but the updated tasks could not be saved in this browser.");
  }
  if (changedTaskIds.size) render();

  await deleteGoogleEvents(accessToken);

  const unlinkedTasks = tasks.filter((task) => task.dueDate && !task.calendarEventId);
  for (const task of unlinkedTasks) {
    const event = await createGoogleEvent(accessToken, task);
    task.calendarEventId = event.id;
    if (!saveTasks()) {
      throw new Error(`The event for "${task.title}" was created, but its link could not be saved. Remove it from Google Calendar before syncing again to avoid a duplicate.`);
    }
  }

  render();
  hideNotice();
}

async function fetchGoogleEvents(accessToken) {
  const now = new Date();
  const timeMin = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30).toISOString();
  const timeMax = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate()).toISOString();
  const results = [];
  let pageToken = "";

  do {
    const query = new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: "true",
      showDeleted: "true",
      maxResults: "250",
      orderBy: "startTime"
    });
    if (pageToken) query.set("pageToken", pageToken);

    const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${query}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await readGoogleResponse(response);
    if (Array.isArray(data.items)) results.push(...data.items);
    pageToken = data.nextPageToken || "";
  } while (pageToken);

  return results;
}

async function deleteGoogleEvents(accessToken) {
  const deletedEventIds = loadDeletedEventIds();
  const remainingEventIds = [...deletedEventIds];
  let changed = false;

  for (const eventId of deletedEventIds) {
    const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!response.ok && response.status !== 404 && response.status !== 410) {
      await readGoogleResponse(response);
    }
    remainingEventIds.splice(remainingEventIds.indexOf(eventId), 1);
    changed = true;
  }

  if (changed) {
    try {
      localStorage.setItem(DELETED_EVENTS_KEY, JSON.stringify(remainingEventIds));
    } catch (error) {
      throw new Error(`Google Calendar events were deleted, but the deletion queue could not be saved: ${error.message}`);
    }
  }
}

async function createGoogleEvent(accessToken, task) {
  const response = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      summary: task.title,
      start: { date: task.dueDate },
      end: { date: nextDateKey(task.dueDate) }
    })
  });
  const event = await readGoogleResponse(response);
  if (!event.id) throw new Error(`Google Calendar did not return an event ID for "${task.title}".`);
  return event;
}

async function readGoogleResponse(response) {
  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw new Error(`Google Calendar returned an unreadable response (HTTP ${response.status}): ${error.message}`);
  }
  if (!response.ok) {
    throw new Error(data.error && data.error.message ? data.error.message : `Google Calendar returned HTTP ${response.status}.`);
  }
  return data;
}

function showNotice(message) {
  if (!notice) return;
  notice.textContent = message;
  notice.hidden = false;
}

function hideNotice() {
  if (!notice) return;
  notice.textContent = "";
  notice.hidden = true;
}

render();
