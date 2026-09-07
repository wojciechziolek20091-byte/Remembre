/*
  Remembre
  --------
  A single-file, dependency-free calendar for schoolwork. Tasks live in
  localStorage on the reader's own machine; nothing is sent anywhere.

  The three views (month grid, agenda, sidebar) are all rendered from one
  array of task objects:

    { id, title, type, course, date: "YYYY-MM-DD", time: "HH:MM" | "",
      notes, done, createdAt }

  Dates are handled as local "YYYY-MM-DD" strings and never as Date objects
  in storage, which keeps a task due on the 14th on the 14th regardless of
  the reader's time zone.
*/

"use strict";

/* ---------- Constants ---------- */

const STORAGE_KEY = "remembre.tasks.v1";
const PREFS_KEY = "remembre.prefs.v1";
const LOCALE = "en-GB";
const MAX_CHIPS = 3;
const UPCOMING_LIMIT = 6;

const TYPES = {
  test: { label: "Test", order: 0 },
  homework: { label: "Homework", order: 1 },
  project: { label: "Project", order: 2 },
  other: { label: "Other", order: 3 },
};

const TYPE_KEYS = Object.keys(TYPES);

const fmtMonthYear = new Intl.DateTimeFormat(LOCALE, { month: "long", year: "numeric" });
const fmtFullDate = new Intl.DateTimeFormat(LOCALE, {
  weekday: "long", day: "numeric", month: "long", year: "numeric",
});
const fmtMediumDate = new Intl.DateTimeFormat(LOCALE, {
  weekday: "long", day: "numeric", month: "long",
});
const fmtShortDate = new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short" });

/* ---------- Small helpers ---------- */

function $(id) {
  return document.getElementById(id);
}

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key in node && key !== "list") node[key] = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function toISO(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function fromISO(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function todayISO() {
  return toISO(new Date());
}

function addDays(iso, days) {
  const date = fromISO(iso);
  date.setDate(date.getDate() + days);
  return toISO(date);
}

function addMonths(iso, months) {
  const date = fromISO(iso);
  const day = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + months);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(day, lastDay));
  return toISO(date);
}

function daysBetween(fromIso, toIso) {
  return Math.round((fromISO(toIso) - fromISO(fromIso)) / 86400000);
}

/** Monday-first weekday index: Monday is 0, Sunday is 6. */
function weekdayIndex(date) {
  return (date.getDay() + 6) % 7;
}

function isValidISO(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = fromISO(value);
  return !Number.isNaN(date.getTime()) && toISO(date) === value;
}

function formatTime(time) {
  if (!time) return "";
  const [h, m] = time.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return "";
  return `${pad(h)}:${pad(m)}`;
}

/** "Today", "Tomorrow", "in 4 days", "3 days overdue" and so on. */
function relativeDay(iso, reference) {
  const diff = daysBetween(reference, iso);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday, overdue";
  if (diff < 0) return `${Math.abs(diff)} days overdue`;
  if (diff < 7) return `In ${diff} days`;
  if (diff < 14) return "Next week";
  return `In ${Math.round(diff / 7)} weeks`;
}

function newId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
}

/* ---------- Persistence ---------- */

function readStore(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.warn("Could not read saved data:", err);
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn("Could not save data:", err);
    return false;
  }
}

/** Accepts anything and returns a task we are willing to render, or null. */
function normaliseTask(raw) {
  if (!raw || typeof raw !== "object") return null;
  const title = String(raw.title == null ? "" : raw.title).trim().slice(0, 120);
  const date = String(raw.date == null ? "" : raw.date);
  if (!title || !isValidISO(date)) return null;
  const type = TYPE_KEYS.includes(raw.type) ? raw.type : "other";
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : newId(),
    title,
    type,
    date,
    time: /^\d{2}:\d{2}$/.test(raw.time || "") ? raw.time : "",
    course: String(raw.course == null ? "" : raw.course).trim().slice(0, 60),
    notes: String(raw.notes == null ? "" : raw.notes).trim().slice(0, 500),
    done: raw.done === true,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
  };
}

function loadTasks() {
  const raw = readStore(STORAGE_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.map(normaliseTask).filter(Boolean);
}

function saveTasks() {
  if (!writeStore(STORAGE_KEY, state.tasks)) {
    announce("Your browser would not let this page save data, so changes will be lost when you close the tab.");
  }
}

function savePrefs() {
  writeStore(PREFS_KEY, {
    theme: state.theme,
    view: state.view,
    types: state.typeFilter,
    showDone: state.showDone,
  });
}

/* ---------- State ---------- */

const state = {
  tasks: [],
  view: "month",
  theme: "auto",
  typeFilter: TYPE_KEYS.slice(),
  showDone: false,
  /** First day of the month currently on screen. */
  periodStart: "",
  /** The date that owns the calendar grid's single tab stop. */
  focusDate: "",
  editingId: null,
  dayDialogDate: "",
  /** Where to send focus after the task dialog closes. */
  returnFocus: null,
};

/* ---------- Task queries ---------- */

function passesFilter(task) {
  if (!state.typeFilter.includes(task.type)) return false;
  if (task.done && !state.showDone) return false;
  return true;
}

function sortTasks(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (Boolean(a.done) !== Boolean(b.done)) return a.done ? 1 : -1;
  const aTime = a.time || "99:99";
  const bTime = b.time || "99:99";
  if (aTime !== bTime) return aTime < bTime ? -1 : 1;
  if (a.type !== b.type) return TYPES[a.type].order - TYPES[b.type].order;
  return a.title.localeCompare(b.title, LOCALE);
}

function tasksOn(iso, { filtered = true } = {}) {
  return state.tasks
    .filter((task) => task.date === iso && (!filtered || passesFilter(task)))
    .sort(sortTasks);
}

function tasksInMonth(monthStartIso) {
  const prefix = monthStartIso.slice(0, 7);
  return state.tasks
    .filter((task) => task.date.slice(0, 7) === prefix && passesFilter(task))
    .sort(sortTasks);
}

function findTask(id) {
  return state.tasks.find((task) => task.id === id) || null;
}

/* ---------- Announcements ---------- */

let announceTimer = null;

function announce(message) {
  const region = $("live-region");
  window.clearTimeout(announceTimer);
  region.textContent = "";
  announceTimer = window.setTimeout(() => {
    region.textContent = message;
  }, 60);
}

/* ---------- Rendering: shared pieces ---------- */

function typeVars(type) {
  return `--type-color: var(--t-${type}); --type-soft: var(--t-${type}-soft);`;
}

function typeBadge(task) {
  return el(
    "span",
    { class: "badge", style: typeVars(task.type) },
    el("span", { class: `glyph glyph-${task.type}`, "aria-hidden": "true" }),
    TYPES[task.type].label
  );
}

/** A one-line plain-text summary, used for screen-reader labels. */
function describeTask(task) {
  const bits = [TYPES[task.type].label, task.title];
  if (task.course) bits.push(task.course);
  if (task.time) bits.push(`at ${formatTime(task.time)}`);
  if (task.done) bits.push("completed");
  return bits.join(", ");
}

/* ---------- Rendering: month grid ---------- */

function renderCalendar() {
  const body = $("calendar-body");
  const monthStart = fromISO(state.periodStart);
  const monthPrefix = state.periodStart.slice(0, 7);
  const today = todayISO();

  const leading = weekdayIndex(monthStart);
  const daysInMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();
  const totalCells = Math.ceil((leading + daysInMonth) / 7) * 7;
  const gridStart = addDays(state.periodStart, -leading);

  // Keep the grid's single tab stop on a date the grid actually shows.
  const focusOffset = daysBetween(gridStart, state.focusDate);
  if (focusOffset < 0 || focusOffset >= totalCells) {
    state.focusDate = today.slice(0, 7) === monthPrefix ? today : state.periodStart;
  }

  const rows = [];
  for (let cell = 0; cell < totalCells; cell += 1) {
    if (cell % 7 === 0) rows.push(el("tr", {}));
    const iso = addDays(gridStart, cell);
    rows[rows.length - 1].append(buildDayCell(iso, monthPrefix, today));
  }

  body.replaceChildren(...rows);
  $("calendar-caption").textContent = `${fmtMonthYear.format(monthStart)}, week beginning Monday`;
}

function buildDayCell(iso, monthPrefix, today) {
  const date = fromISO(iso);
  const outside = iso.slice(0, 7) !== monthPrefix;
  const isToday = iso === today;
  const weekend = weekdayIndex(date) >= 5;
  const dayTasks = tasksOn(iso);

  const classes = ["is-day"];
  if (outside) classes.push("is-outside");
  if (weekend && !outside) classes.push("is-weekend");
  if (isToday) classes.push("is-today");

  const chips = el("span", { class: "day-chips", "aria-hidden": "true" });
  dayTasks.slice(0, MAX_CHIPS).forEach((task) => {
    chips.append(
      el(
        "span",
        { class: `chip chip-${task.type}${task.done ? " is-done" : ""}` },
        el("span", { class: `chip-glyph glyph glyph-${task.done ? "done" : task.type}` }),
        el("span", { class: "chip-text", text: task.title })
      )
    );
  });
  if (dayTasks.length > MAX_CHIPS) {
    chips.append(el("span", { class: "chip-more", text: `+${dayTasks.length - MAX_CHIPS} more` }));
  }

  const label = [
    fmtFullDate.format(date),
    isToday ? "today" : null,
    dayTasks.length === 0
      ? "no tasks"
      : `${dayTasks.length} ${dayTasks.length === 1 ? "task" : "tasks"}: ${dayTasks.map(describeTask).join("; ")}`,
  ]
    .filter(Boolean)
    .join(". ");

  const button = el(
    "button",
    {
      type: "button",
      class: "day",
      "aria-label": label,
      "aria-haspopup": "dialog",
      tabIndex: iso === state.focusDate ? 0 : -1,
      dataset: { date: iso },
    },
    el("span", { class: "day-num", "aria-hidden": "true", text: String(date.getDate()) }),
    chips
  );
  if (isToday) button.setAttribute("aria-current", "date");

  return el("td", { class: classes.join(" ") }, button);
}

/* ---------- Rendering: agenda ---------- */

function renderAgenda() {
  const wrap = $("agenda");
  const monthTasks = tasksInMonth(state.periodStart);

  if (monthTasks.length === 0) {
    wrap.replaceChildren(buildEmptyMain());
    return;
  }

  const today = todayISO();
  const groups = new Map();
  monthTasks.forEach((task) => {
    if (!groups.has(task.date)) groups.set(task.date, []);
    groups.get(task.date).push(task);
  });

  const sections = [...groups.entries()].map(([iso, tasks]) => {
    const heading = el(
      "h3",
      { class: `agenda-date${iso === today ? " is-today" : ""}` },
      fmtMediumDate.format(fromISO(iso)),
      " ",
      el("span", { class: "agenda-rel", text: relativeDay(iso, today) })
    );
    return el(
      "section",
      { class: "agenda-group" },
      heading,
      el("ul", { class: "task-list" }, tasks.map((task) => buildTaskRow(task)))
    );
  });

  wrap.replaceChildren(...sections);
}

function buildTaskRow(task) {
  const checkboxId = `done-${task.id}`;
  const meta = el("p", { class: "task-meta" }, typeBadge(task));
  if (task.course) meta.append(el("span", { text: task.course }));
  if (task.time) meta.append(el("span", { text: formatTime(task.time) }));

  const row = el(
    "li",
    { class: `task-row${task.done ? " is-done" : ""}`, style: typeVars(task.type) },
    el("input", {
      type: "checkbox",
      class: "task-check",
      id: checkboxId,
      checked: task.done,
      "aria-label": `Mark "${task.title}" as completed`,
      dataset: { toggle: task.id },
    }),
    el(
      "div",
      { class: "task-main" },
      el("button", {
        type: "button",
        class: "task-open",
        text: task.title,
        "aria-haspopup": "dialog",
        dataset: { edit: task.id },
      }),
      meta,
      task.notes ? el("p", { class: "task-notes", text: task.notes }) : null
    )
  );
  return row;
}

function buildEmptyMain() {
  const wrap = el(
    "div",
    { class: "empty empty-main" },
    el("p", {
      text: state.tasks.length === 0
        ? "Nothing here yet. Add your first test or piece of homework to get started."
        : `No tasks in ${fmtMonthYear.format(fromISO(state.periodStart))} matching the filters in the sidebar.`,
    })
  );
  if (state.tasks.length === 0) {
    wrap.append(
      el("button", { type: "button", class: "btn btn-quiet", id: "load-examples", text: "Load a few example tasks" })
    );
  }
  return wrap;
}

/* ---------- Rendering: upcoming ---------- */

function renderUpcoming() {
  const wrap = $("upcoming-list");
  const today = todayISO();
  const pending = state.tasks
    .filter((task) => !task.done && state.typeFilter.includes(task.type))
    .sort(sortTasks);

  const overdue = pending.filter((task) => task.date < today);
  const ahead = pending.filter((task) => task.date >= today).slice(0, UPCOMING_LIMIT);

  if (overdue.length === 0 && ahead.length === 0) {
    wrap.replaceChildren(
      el("p", {
        class: "empty",
        text: state.tasks.length === 0
          ? "Nothing scheduled yet."
          : "Nothing outstanding. Every task matching your filters is done.",
      })
    );
    return;
  }

  const parts = [];
  if (overdue.length > 0) {
    parts.push(el("h3", { class: "up-group-title is-overdue", text: `Overdue (${overdue.length})` }));
    parts.push(el("ul", { class: "up-list" }, overdue.map((task) => buildUpcomingItem(task, today))));
  }
  if (ahead.length > 0) {
    parts.push(el("h3", { class: "up-group-title", text: "Next up" }));
    parts.push(el("ul", { class: "up-list" }, ahead.map((task) => buildUpcomingItem(task, today))));
  }
  wrap.replaceChildren(...parts);
}

function buildUpcomingItem(task, today) {
  const overdue = task.date < today;
  const when = relativeDay(task.date, today);
  const metaBits = [when, fmtShortDate.format(fromISO(task.date))];
  if (task.time) metaBits.push(formatTime(task.time));

  const meta = el("span", { class: "up-meta" }, el("span", { class: "up-when", text: when }), ` · ${metaBits.slice(1).join(" · ")}`);

  return el(
    "li",
    { class: "up-item" },
    el(
      "button",
      {
        type: "button",
        class: `up-btn${overdue ? " is-overdue" : ""}`,
        style: typeVars(task.type),
        "aria-haspopup": "dialog",
        "aria-label": `${task.title}. ${TYPES[task.type].label}${task.course ? `, ${task.course}` : ""}. ${when}, ${fmtFullDate.format(fromISO(task.date))}${task.time ? `, at ${formatTime(task.time)}` : ""}. Open to edit.`,
        dataset: { edit: task.id },
      },
      el("span", { class: "up-title", "aria-hidden": "true" },
        el("span", { class: `glyph glyph-${task.type}` }), " ", task.title),
      el("span", { "aria-hidden": "true" }, meta),
      task.course ? el("span", { class: "up-meta", "aria-hidden": "true", text: task.course }) : null
    )
  );
}

/* ---------- Rendering: chrome ---------- */

function renderPeriod() {
  const monthStart = fromISO(state.periodStart);
  $("period-title").textContent = fmtMonthYear.format(monthStart);
  $("today-label").textContent = fmtFullDate.format(new Date());
}

function renderCourseSuggestions() {
  const courses = [...new Set(state.tasks.map((task) => task.course).filter(Boolean))].sort();
  $("course-suggestions").replaceChildren(...courses.map((course) => el("option", { value: course })));
}

function renderAll() {
  renderPeriod();
  renderCalendar();
  renderAgenda();
  renderUpcoming();
  renderCourseSuggestions();
}

/* ---------- View switching ---------- */

function setView(view) {
  state.view = view === "list" ? "list" : "month";
  $("month-view").hidden = state.view !== "month";
  $("list-view").hidden = state.view !== "list";
  savePrefs();
}

function goToPeriod(iso, { focus = null, announceChange = true } = {}) {
  const date = fromISO(iso);
  state.periodStart = toISO(new Date(date.getFullYear(), date.getMonth(), 1));
  if (focus) state.focusDate = focus;
  renderAll();
  if (announceChange) announce(`Showing ${fmtMonthYear.format(fromISO(state.periodStart))}.`);
}

function focusDayButton(iso) {
  const button = document.querySelector(`.day[data-date="${iso}"]`);
  if (button) button.focus();
  return Boolean(button);
}

/* ---------- Grid keyboard navigation ---------- */

function moveGridFocus(iso) {
  const monthPrefix = state.periodStart.slice(0, 7);
  state.focusDate = iso;
  if (iso.slice(0, 7) !== monthPrefix && !document.querySelector(`.day[data-date="${iso}"]`)) {
    goToPeriod(iso, { focus: iso, announceChange: true });
  } else {
    renderCalendar();
  }
  if (!focusDayButton(iso)) {
    goToPeriod(iso, { focus: iso, announceChange: false });
    focusDayButton(iso);
  }
}

function onGridKeydown(event) {
  const button = event.target.closest(".day");
  if (!button) return;
  const iso = button.dataset.date;
  let next = null;

  switch (event.key) {
    case "ArrowRight": next = addDays(iso, 1); break;
    case "ArrowLeft": next = addDays(iso, -1); break;
    case "ArrowDown": next = addDays(iso, 7); break;
    case "ArrowUp": next = addDays(iso, -7); break;
    case "Home": next = addDays(iso, -weekdayIndex(fromISO(iso))); break;
    case "End": next = addDays(iso, 6 - weekdayIndex(fromISO(iso))); break;
    case "PageUp": next = addMonths(iso, event.shiftKey ? -12 : -1); break;
    case "PageDown": next = addMonths(iso, event.shiftKey ? 12 : 1); break;
    default: return;
  }

  event.preventDefault();
  moveGridFocus(next);
}

/* ---------- Task dialog ---------- */

function openDialog(dialog) {
  if (typeof dialog.showModal !== "function") {
    dialog.setAttribute("open", "");
    return;
  }
  if (!dialog.open) dialog.showModal();
}

function closeDialog(dialog) {
  if (typeof dialog.close === "function" && dialog.open) dialog.close();
  else dialog.removeAttribute("open");
}

function clearFieldErrors() {
  ["task-title", "task-date"].forEach((id) => {
    $(id).removeAttribute("aria-invalid");
    $(`${id}-error`).textContent = "";
  });
}

function openTaskDialog({ id = null, date = null, returnFocus = null } = {}) {
  const dialog = $("task-dialog");
  const task = id ? findTask(id) : null;

  state.editingId = task ? task.id : null;
  state.returnFocus = returnFocus;
  clearFieldErrors();

  $("task-dialog-title").textContent = task ? "Edit task" : "Add a task";
  $("save-task").textContent = task ? "Save changes" : "Add task";
  $("delete-task").hidden = !task;
  $("done-wrap").hidden = !task;

  $("task-title").value = task ? task.title : "";
  $("task-course").value = task ? task.course : "";
  $("task-notes").value = task ? task.notes : "";
  $("task-time").value = task ? task.time : "";
  $("task-date").value = task ? task.date : date || state.focusDate || todayISO();
  $("task-done").checked = task ? task.done : false;
  const type = task ? task.type : "test";
  const typeInput = document.querySelector(`input[name="type"][value="${type}"]`);
  if (typeInput) typeInput.checked = true;

  openDialog(dialog);
  $("task-title").focus();
}

function validateTaskForm() {
  clearFieldErrors();
  let firstInvalid = null;

  const title = $("task-title").value.trim();
  if (!title) {
    $("task-title").setAttribute("aria-invalid", "true");
    $("task-title-error").textContent = "Give the task a title so you can recognise it later.";
    firstInvalid = firstInvalid || $("task-title");
  }

  const date = $("task-date").value;
  if (!isValidISO(date)) {
    $("task-date").setAttribute("aria-invalid", "true");
    $("task-date-error").textContent = "Choose a due date, in the format YYYY-MM-DD.";
    firstInvalid = firstInvalid || $("task-date");
  }

  if (firstInvalid) {
    firstInvalid.focus();
    return null;
  }

  const selectedType = document.querySelector('input[name="type"]:checked');
  return {
    title,
    date,
    type: selectedType ? selectedType.value : "other",
    time: $("task-time").value || "",
    course: $("task-course").value.trim(),
    notes: $("task-notes").value.trim(),
    done: $("task-done").checked,
  };
}

function submitTaskForm(event) {
  event.preventDefault();
  const values = validateTaskForm();
  if (!values) return;

  const existing = state.editingId ? findTask(state.editingId) : null;
  if (existing) {
    Object.assign(existing, values);
    announce(`Saved "${values.title}", due ${fmtFullDate.format(fromISO(values.date))}.`);
  } else {
    state.tasks.push(normaliseTask({ ...values, id: newId(), createdAt: new Date().toISOString() }));
    announce(`Added "${values.title}", due ${fmtFullDate.format(fromISO(values.date))}.`);
  }

  saveTasks();
  closeDialog($("task-dialog"));
  goToPeriod(values.date, { focus: values.date, announceChange: false });
  restoreFocus(values.date);
}

function deleteCurrentTask() {
  const task = state.editingId ? findTask(state.editingId) : null;
  if (!task) return;
  const confirmed = window.confirm(`Delete "${task.title}"? This cannot be undone.`);
  if (!confirmed) return;

  const date = task.date;
  state.tasks = state.tasks.filter((item) => item.id !== task.id);
  saveTasks();
  closeDialog($("task-dialog"));
  renderAll();
  announce(`Deleted "${task.title}".`);
  restoreFocus(date);
}

function restoreFocus(dateIso) {
  const target = state.returnFocus;
  state.returnFocus = null;
  if (target === "add-button") {
    $("add-task-top").focus();
    return;
  }
  if (state.view === "month" && dateIso && focusDayButton(dateIso)) return;
  $("add-task-top").focus();
}

/* ---------- Day dialog ---------- */

function openDayDialog(iso) {
  state.dayDialogDate = iso;
  const dialog = $("day-dialog");
  const dayTasks = tasksOn(iso, { filtered: false });
  const today = todayISO();

  $("day-dialog-title").textContent = fmtFullDate.format(fromISO(iso));

  const body = $("day-dialog-body");
  const parts = [
    el("p", {
      class: "day-dialog-meta",
      text: `${relativeDay(iso, today)} · ${dayTasks.length === 0 ? "nothing scheduled" : `${dayTasks.length} ${dayTasks.length === 1 ? "task" : "tasks"}`}`,
    }),
  ];

  if (dayTasks.length > 0) {
    parts.push(el("ul", { class: "task-list" }, dayTasks.map((task) => buildTaskRow(task))));
  } else {
    parts.push(el("p", { class: "empty", text: "No tests, homework or assignments on this day yet." }));
  }

  body.replaceChildren(...parts);
  openDialog(dialog);
  $("add-on-day").focus();
}

function refreshDayDialog() {
  if ($("day-dialog").open && state.dayDialogDate) {
    const active = document.activeElement;
    const toggleId = active && active.dataset ? active.dataset.toggle : null;
    openDayDialog(state.dayDialogDate);
    if (toggleId) {
      const restored = $("day-dialog-body").querySelector(`[data-toggle="${toggleId}"]`);
      if (restored) restored.focus();
    }
  }
}

/* ---------- Task actions ---------- */

function toggleTaskDone(id, done) {
  const task = findTask(id);
  if (!task) return;

  // Completing a task can remove its row outright (when completed tasks are
  // hidden), which would drop keyboard focus to the document body. Remember
  // where the reader was so focus can be put somewhere sensible afterwards.
  const active = document.activeElement;
  const inAgenda = Boolean(active && active.closest && active.closest("#agenda"));
  const index = inAgenda
    ? [...document.querySelectorAll("#agenda .task-check")].findIndex((box) => box.dataset.toggle === id)
    : -1;

  task.done = done;
  saveTasks();
  renderAll();
  refreshDayDialog();

  const hidden = done && !state.showDone;
  announce(
    `"${task.title}" marked as ${done ? "completed" : "still to do"}` +
    (hidden ? ", and hidden because completed tasks are switched off." : ".")
  );

  if (inAgenda) restoreAgendaFocus(id, index);
}

/** Put focus back on the same task, or on whatever took its place. */
function restoreAgendaFocus(id, index) {
  const agenda = $("agenda");
  const same = agenda.querySelector(`[data-toggle="${id}"]`);
  if (same) {
    same.focus();
    return;
  }
  const boxes = [...agenda.querySelectorAll(".task-check")];
  if (boxes.length === 0) {
    agenda.focus();
    return;
  }
  boxes[Math.min(Math.max(index, 0), boxes.length - 1)].focus();
}

/* ---------- Filters and theme ---------- */

function readFilters() {
  state.typeFilter = [...document.querySelectorAll(".type-filter")]
    .filter((input) => input.checked)
    .map((input) => input.value);
  state.showDone = $("show-done").checked;
  savePrefs();
  renderAll();
}

function applyTheme(theme) {
  state.theme = ["light", "dark", "auto"].includes(theme) ? theme : "auto";
  if (state.theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", state.theme);
  savePrefs();
}

/* ---------- Import and export ---------- */

function exportBackup() {
  const payload = JSON.stringify({ app: "remembre", version: 1, tasks: state.tasks }, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = el("a", { href: url, download: `remembre-${todayISO()}.json` });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  announce(`Exported ${state.tasks.length} ${state.tasks.length === 1 ? "task" : "tasks"}.`);
}

function importBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try {
      parsed = JSON.parse(String(reader.result));
    } catch (err) {
      window.alert("That file is not a Remembre backup: it is not valid JSON.");
      return;
    }
    const list = Array.isArray(parsed) ? parsed : parsed && parsed.tasks;
    if (!Array.isArray(list)) {
      window.alert("That file does not contain a list of tasks.");
      return;
    }
    const incoming = list.map(normaliseTask).filter(Boolean);
    if (incoming.length === 0) {
      window.alert("No readable tasks were found in that file.");
      return;
    }
    const replace = window.confirm(
      `Found ${incoming.length} ${incoming.length === 1 ? "task" : "tasks"}.\n\n` +
      "OK: replace everything currently in this calendar.\n" +
      "Cancel: add them alongside what is already here."
    );
    if (replace) {
      state.tasks = incoming;
    } else {
      const known = new Set(state.tasks.map((task) => task.id));
      incoming.forEach((task) => {
        if (known.has(task.id)) task.id = newId();
        state.tasks.push(task);
      });
    }
    saveTasks();
    renderAll();
    announce(`Imported ${incoming.length} ${incoming.length === 1 ? "task" : "tasks"}.`);
  };
  reader.onerror = () => window.alert("That file could not be read.");
  reader.readAsText(file);
}

function loadExamples() {
  const today = todayISO();
  const examples = [
    { title: "History essay, chapter 5", type: "homework", course: "History", date: addDays(today, 2), time: "09:00" },
    { title: "Chemistry lab report", type: "project", course: "Chemistry", date: addDays(today, 5), notes: "Include the titration graph and the error analysis." },
    { title: "Algebra test", type: "test", course: "Mathematics", date: addDays(today, 7), time: "11:30", notes: "Quadratics and simultaneous equations." },
    { title: "Read Chapters 3 to 4", type: "homework", course: "English", date: addDays(today, 1) },
    { title: "Biology presentation", type: "project", course: "Biology", date: addDays(today, 12), time: "14:00" },
    { title: "Return library books", type: "other", date: addDays(today, 3) },
  ];
  examples.forEach((example) => {
    state.tasks.push(normaliseTask({ ...example, id: newId(), createdAt: new Date().toISOString() }));
  });
  saveTasks();
  renderAll();
  announce(`Added ${examples.length} example tasks. Edit or delete them whenever you like.`);
}

/* ---------- Wiring ---------- */

function setupEvents() {
  $("add-task-top").addEventListener("click", () => {
    openTaskDialog({ date: state.focusDate || todayISO(), returnFocus: "add-button" });
  });

  $("prev-period").addEventListener("click", () => goToPeriod(addMonths(state.periodStart, -1)));
  $("next-period").addEventListener("click", () => goToPeriod(addMonths(state.periodStart, 1)));
  $("go-today").addEventListener("click", () => {
    goToPeriod(todayISO(), { focus: todayISO() });
    if (state.view === "month") focusDayButton(todayISO());
  });

  document.querySelectorAll('input[name="view"]').forEach((input) => {
    input.addEventListener("change", () => {
      setView(input.value);
      announce(input.value === "list" ? "Agenda view." : "Month view.");
    });
  });

  document.querySelectorAll('input[name="theme"]').forEach((input) => {
    input.addEventListener("change", () => applyTheme(input.value));
  });

  document.querySelectorAll(".type-filter").forEach((input) => {
    input.addEventListener("change", readFilters);
  });
  $("show-done").addEventListener("change", readFilters);

  const grid = $("calendar-body");
  grid.addEventListener("keydown", onGridKeydown);
  grid.addEventListener("click", (event) => {
    const button = event.target.closest(".day");
    if (!button) return;
    state.focusDate = button.dataset.date;
    openDayDialog(button.dataset.date);
  });

  // Task rows appear in both the agenda and the day dialog.
  document.addEventListener("click", (event) => {
    const editButton = event.target.closest("[data-edit]");
    if (editButton) {
      const task = findTask(editButton.dataset.edit);
      if (!task) return;
      closeDialog($("day-dialog"));
      openTaskDialog({ id: task.id });
      return;
    }
    if (event.target.id === "load-examples") loadExamples();
  });

  document.addEventListener("change", (event) => {
    const toggle = event.target.closest("[data-toggle]");
    if (toggle) toggleTaskDone(toggle.dataset.toggle, toggle.checked);
  });

  $("task-form").addEventListener("submit", submitTaskForm);
  $("delete-task").addEventListener("click", deleteCurrentTask);

  $("add-on-day").addEventListener("click", () => {
    const date = state.dayDialogDate;
    closeDialog($("day-dialog"));
    openTaskDialog({ date });
  });

  document.querySelectorAll("[data-close]").forEach((button) => {
    button.addEventListener("click", () => closeDialog($(button.dataset.close)));
  });

  $("day-dialog").addEventListener("close", () => {
    if (!$("task-dialog").open && state.dayDialogDate && state.view === "month") {
      focusDayButton(state.dayDialogDate);
    }
  });

  $("export-data").addEventListener("click", exportBackup);
  $("import-data").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) importBackup(file);
    event.target.value = "";
  });

  document.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    const typing = target.closest("input, textarea, select, [contenteditable='true']");
    if (typing || $("task-dialog").open || $("day-dialog").open) return;
    if (event.key === "n" || event.key === "N") {
      event.preventDefault();
      openTaskDialog({ date: state.focusDate || todayISO(), returnFocus: "add-button" });
    } else if (event.key === "t" || event.key === "T") {
      event.preventDefault();
      goToPeriod(todayISO(), { focus: todayISO() });
      if (state.view === "month") focusDayButton(todayISO());
    }
  });
}

function restorePrefs() {
  const prefs = readStore(PREFS_KEY, {});

  // With no stored choice, leave data-theme exactly as we found it rather than
  // clearing it: when this page is embedded somewhere that sets the attribute
  // itself, removing it would override the host's theme on first load.
  if (prefs.theme) applyTheme(prefs.theme);
  else state.theme = "auto";
  const themeInput = document.querySelector(`input[name="theme"][value="${state.theme}"]`);
  if (themeInput) themeInput.checked = true;

  setView(prefs.view === "list" ? "list" : "month");
  const viewInput = document.querySelector(`input[name="view"][value="${state.view}"]`);
  if (viewInput) viewInput.checked = true;

  if (Array.isArray(prefs.types) && prefs.types.length > 0) {
    state.typeFilter = prefs.types.filter((type) => TYPE_KEYS.includes(type));
  }
  document.querySelectorAll(".type-filter").forEach((input) => {
    input.checked = state.typeFilter.includes(input.value);
  });

  state.showDone = prefs.showDone === true;
  $("show-done").checked = state.showDone;
}

function init() {
  state.tasks = loadTasks();
  const today = todayISO();
  state.focusDate = today;
  state.periodStart = today.slice(0, 8) + "01";
  restorePrefs();
  setupEvents();
  renderAll();
}

document.addEventListener("DOMContentLoaded", init);
