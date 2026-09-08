/*
  Remembre
  --------
  A single-file, dependency-free calendar for schoolwork. Tasks live in
  localStorage on the reader's own machine; nothing is sent anywhere.

  The three views (month grid, agenda, sidebar) are all rendered from one
  array of task objects:

    { id, title, type, course, date: "YYYY-MM-DD", time: "HH:MM" | "",
      notes, done, createdAt, updatedAt, deleted }

  Every record carries updatedAt, and deleting sets `deleted` rather than
  dropping the row. Both exist so a file saved on one device can be merged
  into another without either losing work: newer wins per task, and a deletion
  travels as a fact instead of silently reappearing on the next merge.

  Dates are handled as local "YYYY-MM-DD" strings and never as Date objects
  in storage, which keeps a task due on the 14th on the 14th regardless of
  the reader's time zone.
*/

"use strict";

/* ---------- Constants ---------- */

/* Shown in the footer so it is always possible to tell, on the device itself,
   which release is actually running. Bump it on every deploy. */
const APP_VERSION = "2026.09.08-15";

const STORAGE_KEY = "remembre.tasks.v1";
const PREFS_KEY = "remembre.prefs.v1";
const SYNC_KEY = "remembre.sync.v1";
const REMINDERS_KEY = "remembre.reminders.v1";

/* A reminder is due at this hour on the day before the task. */
const REMINDER_HOUR = 17;
/* How often to look, while the app is open. */
const REMINDER_POLL_MS = 60000;
const LOCALE = "en-GB";
const MAX_CHIPS = 3;
const UPCOMING_LIMIT = 6;
/* Tombstones are kept long enough to reach every device, then dropped. */
const TOMBSTONE_DAYS = 90;
const BACKUP_FILENAME = "remembre.json";

const TYPES = {
  homework: { label: "Homework", plural: "Homework", order: 0 },
  test: { label: "Test", plural: "Tests", order: 1 },
  project: { label: "Project", plural: "Projects", order: 2 },
  other: { label: "Other", plural: "Other", order: 3 },
};

const TYPE_KEYS = Object.keys(TYPES);
/* Only these two can be created now. The other two stay in TYPES so tasks made
   before the form changed still render and still filter. */
const FORM_TYPES = ["homework", "test"];

const SUBJECTS = {
  economics: { label: "Economics" },
  mathematics: { label: "Mathematics" },
  english: { label: "English" },
  polish: { label: "Polish" },
  history: { label: "History" },
  ess: { label: "ESS" },
};

const SUBJECT_KEYS = Object.keys(SUBJECTS);

const CHAPTER_MAX = 20;

/*
  The school timetable, as a grid of periods by weekday (Monday first).

  Periods run 0 to 8 and sit in blocks that share a start time: 0 alone, then
  1-2, 3-4, 5-6 and 7-8. Clicking a lesson opens the add form already knowing
  the subject, the date of that weekday in the week on screen, and the block's
  start time.

  To change your timetable, edit TIMETABLE_ROWS. `subject` must be one of the
  keys in SUBJECTS, or "" for a lesson that carries no coursework subject.
*/
const TIMETABLE_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

const PERIOD_TIMES = ["08:00", "08:45", "08:45", "10:35", "10:35", "12:10", "12:10", "14:10", "14:10"];

const lesson = (subject, label, room) => ({ subject, label, room });
const maths = (room) => lesson("mathematics", "Maths AI HL", room);
const econ = (room) => lesson("economics", "Economics HL", room);
const eng = (room) => lesson("english", "English B HL", room);
const pol = (room) => lesson("polish", "Polish A SL", room);
const hist = (room) => lesson("history", "History SL", room);
const ess = (room) => lesson("ess", "ESS SL", room);

/* One row per period; five entries per row, Monday to Friday, null when free. */
const TIMETABLE_ROWS = [
  /* 0 */ [null, null, maths("R_36"), null, null],
  /* 1 */ [null, econ("R_30"), maths("R_36"), null, null],
  /* 2 */ [null, econ("R_30"), lesson("", "Tutor", "R_35"), null, null],
  /* 3 */ [ess("R_36"), lesson("", "TOK", "R_b4"), null, hist("R_b2"), maths("R_b3")],
  /* 4 */ [ess("R_36"), lesson("", "TOK", "R_b4"), null, hist("R_b2"), maths("R_b3")],
  /* 5 */ [eng("R_36"), eng("R_35"), econ("R_30"), ess("R_b4"), eng("R_35")],
  /* 6 */ [eng("R_36"), eng("R_35"), econ("R_30"), ess("R_b4"), eng("R_35")],
  /* 7 */ [maths("R_36"), pol("R_36"), pol("R_36"), econ("R_30"), hist("R_b2")],
  /* 8 */ [maths("R_36"), pol("R_36"), pol("R_36"), econ("R_30"), hist("R_b2")],
];

/*
  Two subjects ask follow-up questions. `kinds` is the first of them; a kind
  listed in `chaptersFor` (or any kind, when that is null) goes on to chapters.
  `sections` splits those chapters into named groups -- maths chapters belong
  either to the core topics or to HL AI, and a piece of work can span both --
  while a subject with no sections collects one unnamed set.
*/
const SUBJECT_DETAIL = {
  mathematics: {
    kindLegend: "What kind of maths work?",
    kinds: [
      { id: "test", label: "Test" },
      { id: "short-test", label: "Short test" },
      { id: "study", label: "Study" },
      { id: "other", label: "Other" },
    ],
    chaptersFor: null,
    sectionLegend: "Which part of the course?",
    sectionHint: "Pick either, or both if the work spans them.",
    sections: [
      { id: "core", label: "Core Topics" },
      { id: "hlai", label: "HL AI" },
    ],
  },
  economics: {
    kindLegend: "What kind of economics work?",
    kinds: [
      { id: "self-study", label: "Self Study" },
      { id: "practice-paper", label: "Practice paper" },
      { id: "other", label: "Other" },
    ],
    chaptersFor: ["self-study", "practice-paper"],
    sections: null,
  },
};

function detailSchema(subject) {
  return SUBJECT_DETAIL[subject] || null;
}

/** Does this kind go on to ask for chapters? */
function kindTakesChapters(schema, kind) {
  if (!schema || !kind) return false;
  return schema.chaptersFor === null || schema.chaptersFor.includes(kind);
}

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
  // A tombstone only has to carry an id and a timestamp to do its job.
  if ((!title || !isValidISO(date)) && raw.deleted !== true) return null;
  const type = TYPE_KEYS.includes(raw.type) ? raw.type : "other";
  const createdAt = typeof raw.createdAt === "string" && raw.createdAt
    ? raw.createdAt
    : new Date().toISOString();
  const subject = SUBJECT_KEYS.includes(raw.subject) ? raw.subject : "";
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : newId(),
    title,
    type,
    subject,
    detail: normaliseDetail(subject, raw.detail),
    date,
    time: /^\d{2}:\d{2}$/.test(raw.time || "") ? raw.time : "",
    course: String(raw.course == null ? "" : raw.course).trim().slice(0, 60),
    notes: String(raw.notes == null ? "" : raw.notes).trim().slice(0, 500),
    done: raw.done === true,
    deleted: raw.deleted === true,
    createdAt,
    // A file written before updatedAt existed still merges: it simply loses
    // every tie, which is the safe direction.
    updatedAt: typeof raw.updatedAt === "string" && raw.updatedAt ? raw.updatedAt : createdAt,
  };
}

/** Trims a stored detail down to what the subject's schema actually allows. */
function normaliseDetail(subject, raw) {
  const schema = detailSchema(subject);
  if (!schema || !raw || typeof raw !== "object") return null;
  const kind = schema.kinds.some((option) => option.id === raw.kind) ? raw.kind : "";
  if (!kind) return null;

  const parts = [];
  (Array.isArray(raw.parts) ? raw.parts : []).forEach((part) => {
    if (!part || typeof part !== "object") return;
    const section = schema.sections ? String(part.section || "") : "";
    if (schema.sections && !schema.sections.some((option) => option.id === section)) return;
    if (parts.some((existing) => existing.section === section)) return;
    const chapters = [...new Set((Array.isArray(part.chapters) ? part.chapters : [])
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= CHAPTER_MAX))]
      .sort((x, y) => x - y);
    parts.push({ section, chapters });
  });

  return { kind, parts };
}

/* A deleted task keeps its row so the deletion can travel; the interface
   never sees one. */
function liveTasks() {
  return state.tasks.filter((task) => !task.deleted);
}

function touch(task) {
  task.updatedAt = new Date().toISOString();
  return task;
}

function loadTasks() {
  const raw = readStore(STORAGE_KEY, []);
  if (!Array.isArray(raw)) return [];
  const cutoff = new Date(Date.now() - TOMBSTONE_DAYS * 86400000).toISOString();
  return raw
    .map(normaliseTask)
    .filter(Boolean)
    .filter((task) => !task.deleted || task.updatedAt > cutoff);
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
  /** Monday of the week currently on screen. */
  weekStart: "",
  /** Which lesson owns the timetable's single tab stop. */
  lessonFocus: { day: 0, period: 0 },
  /** The date that owns the calendar grid's single tab stop. */
  focusDate: "",
  editingId: null,
  /** Working copy of the add / edit form's branching answers. */
  form: { subject: "", detail: { kind: "", parts: [] }, titleDirty: false },
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
  return liveTasks()
    .filter((task) => task.date === iso && (!filtered || passesFilter(task)))
    .sort(sortTasks);
}

function tasksInMonth(monthStartIso) {
  const prefix = monthStartIso.slice(0, 7);
  return liveTasks()
    .filter((task) => task.date.slice(0, 7) === prefix && passesFilter(task))
    .sort(sortTasks);
}

function findTask(id) {
  return liveTasks().find((task) => task.id === id) || null;
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

/** Every subject has its own hue; anything without one falls back to neutral. */
function subjectVars(subject) {
  const key = subject && SUBJECTS[subject] ? subject : "none";
  return `--subject-color: var(--s-${key}); --subject-soft: var(--s-${key}-soft);`;
}

function subjectLabel(task) {
  if (task.subject && SUBJECTS[task.subject]) return SUBJECTS[task.subject].label;
  return task.course || "No subject";
}

/** The coloured badge names the subject; the tag beside it names the type. */
function subjectBadge(task) {
  return el("span", { class: "badge", style: subjectVars(task.subject) }, subjectLabel(task));
}

function typeTag(task) {
  return el(
    "span",
    { class: "type-tag" },
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
        { class: `chip${task.done ? " is-done" : ""}`, style: subjectVars(task.subject) },
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

/* ---------- Rendering: the timetable ---------- */

function weekStartFor(iso) {
  return addDays(iso, -weekdayIndex(fromISO(iso)));
}

function weekTitle(start) {
  const monday = fromISO(start);
  const friday = fromISO(addDays(start, 4));
  const day = new Intl.DateTimeFormat(LOCALE, { day: "numeric" });
  const dayMonth = new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "long" });
  const full = new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "long", year: "numeric" });
  return monday.getMonth() === friday.getMonth()
    ? `${day.format(monday)}\u2013${full.format(friday)}`
    : `${dayMonth.format(monday)} \u2013 ${full.format(friday)}`;
}

/** The first lesson at or after a position, searching the whole grid. */
function firstLesson() {
  for (let period = 0; period < TIMETABLE_ROWS.length; period += 1) {
    for (let day = 0; day < TIMETABLE_DAYS.length; day += 1) {
      if (TIMETABLE_ROWS[period][day]) return { day, period };
    }
  }
  return null;
}

/*
  Places each of a day's tasks on exactly one lesson, so a subject taught twice
  in a day does not show the same task twice. A task with a time goes to the
  lesson at that time; otherwise it goes to the day's first lesson in that
  subject. Anything with no lesson to sit on is returned separately rather than
  being dropped, because a week view that hides due work is worse than useless.
*/
function assignTasksToLessons(iso, dayIndex) {
  const byPeriod = new Map();
  const unplaced = [];

  tasksOn(iso).forEach((task) => {
    const candidates = [];
    if (task.subject) {
      TIMETABLE_ROWS.forEach((row, period) => {
        if (row[dayIndex] && row[dayIndex].subject === task.subject) candidates.push(period);
      });
    }
    if (candidates.length === 0) {
      unplaced.push(task);
      return;
    }
    const atTime = task.time ? candidates.filter((period) => PERIOD_TIMES[period] === task.time) : [];
    const period = (atTime.length > 0 ? atTime : candidates)[0];
    if (!byPeriod.has(period)) byPeriod.set(period, []);
    byPeriod.get(period).push(task);
  });

  return { byPeriod, unplaced };
}

function renderTimetable() {
  const today = todayISO();
  const start = state.weekStart;
  const placement = TIMETABLE_DAYS.map((unused, dayIndex) =>
    assignTasksToLessons(addDays(start, dayIndex), dayIndex));

  if (!TIMETABLE_ROWS[state.lessonFocus.period] ||
      !TIMETABLE_ROWS[state.lessonFocus.period][state.lessonFocus.day]) {
    state.lessonFocus = firstLesson() || { day: 0, period: 0 };
  }

  $("timetable-head").replaceChildren(
    el("th", { scope: "col", class: "tt-corner" }, el("span", { class: "sr-only", text: "Period" })),
    ...TIMETABLE_DAYS.map((name, dayIndex) => {
      const iso = addDays(start, dayIndex);
      const isToday = iso === today;
      // The column is today, not each of its lessons: marking every lesson
      // would have a screen reader announce "current date" six times over.
      const cell = el(
        "th",
        { scope: "col", class: `tt-day${isToday ? " is-today" : ""}` },
        el("span", { class: "tt-day-name", text: name }),
        el("span", { class: "tt-day-date", text: fmtShortDate.format(fromISO(iso)) })
      );
      if (isToday) cell.setAttribute("aria-current", "date");
      return cell;
    })
  );

  const rows = TIMETABLE_ROWS.map((row, period) => el(
    "tr",
    {},
    el(
      "th",
      { scope: "row", class: "tt-period" },
      el("span", { class: "tt-period-num", text: String(period) }),
      el("span", { class: "tt-period-time", text: PERIOD_TIMES[period] })
    ),
    ...row.map((slot, dayIndex) => buildLessonCell(
      slot, period, dayIndex, start, today,
      placement[dayIndex].byPeriod.get(period) || []
    ))
  ));

  // Only worth a row when something actually has nowhere else to go.
  if (placement.some((day) => day.unplaced.length > 0)) {
    rows.push(el(
      "tr",
      { class: "tt-extra-row" },
      el("th", { scope: "row", class: "tt-period" },
        el("span", { class: "tt-period-num tt-extra-label", text: "Also" }),
        el("span", { class: "tt-period-time", text: "due" })),
      ...TIMETABLE_DAYS.map((unused, dayIndex) =>
        buildUnplacedCell(placement[dayIndex].unplaced, dayIndex, start, today))
    ));
  }

  $("timetable-body").replaceChildren(...rows);

  $("timetable-caption").textContent =
    `School timetable for the week beginning ${fmtFullDate.format(fromISO(start))}`;
}

function taskChips(due, limit) {
  const chips = el("span", { class: "tt-chips", "aria-hidden": "true" });
  due.slice(0, limit).forEach((task) => {
    chips.append(el(
      "span",
      { class: `chip${task.done ? " is-done" : ""}`, style: subjectVars(task.subject) },
      el("span", { class: `chip-glyph glyph glyph-${task.done ? "done" : task.type}` }),
      el("span", { class: "chip-text", text: task.title })
    ));
  });
  if (due.length > limit) {
    chips.append(el("span", { class: "chip-more", text: `+${due.length - limit} more` }));
  }
  return chips;
}

/** Tasks on a day with no lesson to sit against, kept visible in their own row. */
function buildUnplacedCell(due, dayIndex, start, today) {
  const iso = addDays(start, dayIndex);
  const isToday = iso === today;
  const classes = `tt-cell tt-extra${isToday ? " is-today" : ""}`;
  if (due.length === 0) return el("td", { class: classes });

  const label = `${fmtFullDate.format(fromISO(iso))}. ${due.length} ${due.length === 1 ? "task" : "tasks"} with no lesson this day: ${due.map(describeTask).join("; ")}. Open the day`;
  return el("td", { class: classes }, el(
    "button",
    {
      type: "button", class: "tt-lesson tt-extra-btn",
      "aria-label": label, "aria-haspopup": "dialog", tabIndex: -1,
      dataset: { openDay: iso },
    },
    taskChips(due, 2)
  ));
}

function buildLessonCell(slot, period, dayIndex, start, today, due) {
  const iso = addDays(start, dayIndex);
  const isToday = iso === today;
  if (!slot) return el("td", { class: `tt-cell tt-free${isToday ? " is-today" : ""}` });

  const time = PERIOD_TIMES[period];

  const chips = taskChips(due, 2);

  const label = [
    slot.label,
    `room ${slot.room}`,
    `${fmtFullDate.format(fromISO(iso))}, period ${period} at ${time}`,
    due.length
      ? `${due.length} due: ${due.map(describeTask).join("; ")}`
      : null,
    "Add a task for this lesson",
  ].filter(Boolean).join(". ");

  const focused = state.lessonFocus.day === dayIndex && state.lessonFocus.period === period;
  const button = el(
    "button",
    {
      type: "button",
      class: "tt-lesson",
      "aria-label": label,
      "aria-haspopup": "dialog",
      tabIndex: focused ? 0 : -1,
      dataset: {
        day: String(dayIndex), period: String(period),
        date: iso, time, subject: slot.subject,
      },
    },
    el("span", { class: "tt-name", "aria-hidden": "true", text: slot.label }),
    el("span", { class: "tt-room", "aria-hidden": "true", text: slot.room }),
    chips
  );
  return el("td", { class: `tt-cell${isToday ? " is-today" : ""}` }, button);
}

/** Walks in a direction until it lands on a lesson, so gaps are skipped. */
function nextLesson(day, period, stepDay, stepPeriod) {
  let d = day + stepDay;
  let p = period + stepPeriod;
  while (d >= 0 && d < TIMETABLE_DAYS.length && p >= 0 && p < TIMETABLE_ROWS.length) {
    if (TIMETABLE_ROWS[p][d]) return { day: d, period: p };
    d += stepDay;
    p += stepPeriod;
  }
  return null;
}

function focusLesson(day, period) {
  const button = document.querySelector(`.tt-lesson[data-day="${day}"][data-period="${period}"]`);
  if (button) button.focus();
  return Boolean(button);
}

function onTimetableKeydown(event) {
  const button = event.target.closest(".tt-lesson");
  if (!button) return;
  const day = Number(button.dataset.day);
  const period = Number(button.dataset.period);
  let target = null;

  switch (event.key) {
    case "ArrowRight": target = nextLesson(day, period, 1, 0); break;
    case "ArrowLeft": target = nextLesson(day, period, -1, 0); break;
    case "ArrowDown": target = nextLesson(day, period, 0, 1); break;
    case "ArrowUp": target = nextLesson(day, period, 0, -1); break;
    case "Home": target = nextLesson(-1, period, 1, 0); break;
    case "End": target = nextLesson(TIMETABLE_DAYS.length, period, -1, 0); break;
    case "PageUp":
      event.preventDefault();
      goToWeek(addDays(state.weekStart, -7));
      focusLesson(state.lessonFocus.day, state.lessonFocus.period);
      return;
    case "PageDown":
      event.preventDefault();
      goToWeek(addDays(state.weekStart, 7));
      focusLesson(state.lessonFocus.day, state.lessonFocus.period);
      return;
    default: return;
  }

  event.preventDefault();
  if (!target) return;
  state.lessonFocus = target;
  renderTimetable();
  focusLesson(target.day, target.period);
}

function goToWeek(iso, { announceChange = true } = {}) {
  state.weekStart = weekStartFor(iso);
  renderAll();
  if (announceChange) announce(`Showing the week of ${weekTitle(state.weekStart)}.`);
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
  const meta = el("p", { class: "task-meta" }, subjectBadge(task), typeTag(task));
  if (task.time) meta.append(el("span", { text: formatTime(task.time) }));

  const row = el(
    "li",
    { class: `task-row${task.done ? " is-done" : ""}`, style: subjectVars(task.subject) },
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
      text: liveTasks().length === 0
        ? "Nothing here yet. Add your first test or piece of homework to get started."
        : `No tasks in ${fmtMonthYear.format(fromISO(state.periodStart))} matching the filters in the sidebar.`,
    })
  );
  if (liveTasks().length === 0) {
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
  const pending = liveTasks()
    .filter((task) => !task.done && state.typeFilter.includes(task.type))
    .sort(sortTasks);

  const overdue = pending.filter((task) => task.date < today);
  const ahead = pending.filter((task) => task.date >= today).slice(0, UPCOMING_LIMIT);

  if (overdue.length === 0 && ahead.length === 0) {
    wrap.replaceChildren(
      el("p", {
        class: "empty",
        text: liveTasks().length === 0
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
        style: subjectVars(task.subject),
        "aria-haspopup": "dialog",
        "aria-label": `${task.title}. ${TYPES[task.type].label}, ${subjectLabel(task)}. ${when}, ${fmtFullDate.format(fromISO(task.date))}${task.time ? `, at ${formatTime(task.time)}` : ""}. Open to edit.`,
        dataset: { edit: task.id },
      },
      el("span", { class: "up-title", "aria-hidden": "true" },
        el("span", { class: `glyph glyph-${task.type}` }), " ", task.title),
      el("span", { "aria-hidden": "true" }, meta),
      el("span", { class: "up-meta", "aria-hidden": "true", text: subjectLabel(task) })
    )
  );
}

/* ---------- Rendering: chrome ---------- */

function renderPeriod() {
  $("period-title").textContent = state.view === "week"
    ? weekTitle(state.weekStart)
    : fmtMonthYear.format(fromISO(state.periodStart));
  $("today-label").textContent = fmtFullDate.format(new Date());

  const unit = state.view === "week" ? "week" : "month";
  $("prev-period").querySelector(".sr-only").textContent = `Previous ${unit}`;
  $("next-period").querySelector(".sr-only").textContent = `Next ${unit}`;
  $("go-today").textContent = state.view === "week" ? "This week" : "Today";
}

function renderSubjectLegend() {
  $("subject-legend").replaceChildren(...SUBJECT_KEYS.map((key) => el(
    "li",
    {},
    el("span", { class: "swatch", "aria-hidden": "true", style: subjectVars(key) }),
    SUBJECTS[key].label
  )));
}

function renderAll() {
  renderPeriod();
  renderTimetable();
  renderCalendar();
  renderAgenda();
  renderUpcoming();
  renderTypeFilters();
  renderSubjectLegend();
  renderAlertsPanel();
  renderSyncPanel();
}

/* ---------- View switching ---------- */

function setView(view) {
  state.view = ["week", "month", "list"].includes(view) ? view : "week";
  $("week-view").hidden = state.view !== "week";
  $("month-view").hidden = state.view !== "month";
  $("list-view").hidden = state.view !== "list";
  renderPeriod();
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

/* ---------- Naming a task from its choices ---------- */

/** [1,2,3,5,6,9] -> "1-3, 5-6, 9", using an en dash. */
function chapterRange(numbers) {
  const sorted = [...numbers].sort((x, y) => x - y);
  const runs = [];
  sorted.forEach((n) => {
    const last = runs[runs.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  });
  return runs.map(([from, to]) => (from === to ? `${from}` : `${from}\u2013${to}`)).join(", ");
}

/**
 * Turns the structured choices into the name shown on the task, e.g.
 * "Test Chapters 3-5 from Core Topics", or with both parts of the course,
 * "Test Chapters 3-5 from Core Topics; Chapters 7 from HL AI".
 */
function buildTaskName(subject, detail) {
  const schema = detailSchema(subject);
  if (!schema || !detail || !detail.kind) return "";
  const kind = schema.kinds.find((option) => option.id === detail.kind);
  if (!kind) return "";

  const sectionLabel = (id) => {
    const found = schema.sections && schema.sections.find((option) => option.id === id);
    return found ? found.label : "";
  };

  const withChapters = (detail.parts || []).filter((part) => part.chapters.length > 0);
  if (withChapters.length > 0) {
    const pieces = withChapters.map((part) => {
      const chapters = `Chapters ${chapterRange(part.chapters)}`;
      const label = sectionLabel(part.section);
      return label ? `${chapters} from ${label}` : chapters;
    });
    return `${kind.label} ${pieces.join("; ")}`;
  }

  // A section chosen but no chapters yet still names the work usefully.
  const labels = (detail.parts || []).map((part) => sectionLabel(part.section)).filter(Boolean);
  if (labels.length > 0) return `${kind.label} from ${labels.join(" and ")}`;
  return kind.label;
}

/* ---------- The add / edit form ---------- */

/*
  The form asks its questions in order and only reveals the next one once the
  previous is answered: type, subject, then whatever that subject needs. Only
  maths and economics ask anything further.
*/

function emptyFormDetail() {
  return { kind: "", parts: [] };
}

function renderTypeChoice(currentType) {
  const keys = [...FORM_TYPES];
  // An older task may carry a type the form no longer offers. Show it rather
  // than silently rewriting the task when it is saved.
  if (currentType && !keys.includes(currentType)) keys.push(currentType);

  $("type-choice").replaceChildren(...keys.flatMap((key) => {
    const id = `type-${key}`;
    return [
      el("input", { type: "radio", name: "type", id, value: key, checked: currentType === key }),
      el("label", { for: id },
        el("span", { class: `glyph glyph-${key}`, "aria-hidden": "true" }), " ", TYPES[key].label),
    ];
  }));
}

function renderSubjectChoice() {
  $("subject-choice").replaceChildren(...SUBJECT_KEYS.flatMap((key) => {
    const id = `subject-${key}`;
    return [
      el("input", { type: "radio", name: "subject", id, value: key, checked: state.form.subject === key }),
      el("label", { for: id, text: SUBJECTS[key].label }),
    ];
  }));
}

function chapterFieldset(legendText, sectionId, part) {
  const grid = el("div", { class: "chapter-grid" });
  for (let n = 1; n <= CHAPTER_MAX; n += 1) {
    const id = `chapter-${sectionId || "all"}-${n}`;
    grid.append(
      el("input", {
        type: "checkbox", id, value: String(n),
        checked: part.chapters.includes(n),
        dataset: { chapterSection: sectionId },
      }),
      el("label", { for: id, text: String(n) })
    );
  }

  return el(
    "fieldset",
    { class: "field detail-step" },
    el("legend", {}, legendText, " ", el("span", { class: "optional", text: "(choose as many as you like)" })),
    el(
      "div",
      { class: "chapter-tools" },
      el("button", {
        type: "button", class: "btn btn-quiet btn-tiny", text: "All",
        dataset: { chapterAction: "all", chapterSection: sectionId },
      }),
      el("button", {
        type: "button", class: "btn btn-quiet btn-tiny", text: "None",
        dataset: { chapterAction: "none", chapterSection: sectionId },
      })
    ),
    grid
  );
}

function renderDetailSteps({ keepFocus = true } = {}) {
  const wrap = $("detail-steps");
  const activeId = keepFocus && document.activeElement ? document.activeElement.id : "";
  const schema = detailSchema(state.form.subject);

  if (!schema) {
    wrap.replaceChildren();
    syncGeneratedName();
    return;
  }

  const detail = state.form.detail;
  const blocks = [];

  blocks.push(el(
    "fieldset",
    { class: "field detail-step" },
    el("legend", {}, schema.kindLegend, " ", el("span", { class: "req", "aria-hidden": "true", text: "*" })),
    el("div", { class: "type-choice" }, schema.kinds.flatMap((option) => {
      const id = `kind-${option.id}`;
      return [
        el("input", { type: "radio", name: "detail-kind", id, value: option.id, checked: detail.kind === option.id }),
        el("label", { for: id, text: option.label }),
      ];
    }))
  ));

  if (detail.kind && kindTakesChapters(schema, detail.kind)) {
    if (schema.sections) {
      blocks.push(el(
        "fieldset",
        { class: "field detail-step" },
        el("legend", {}, schema.sectionLegend),
        schema.sectionHint ? el("p", { class: "field-hint", text: schema.sectionHint }) : null,
        el("div", { class: "type-choice" }, schema.sections.flatMap((section) => {
          const id = `section-${section.id}`;
          return [
            el("input", {
              type: "checkbox", name: "detail-section", id, value: section.id,
              checked: detail.parts.some((part) => part.section === section.id),
            }),
            el("label", { for: id, text: section.label }),
          ];
        }))
      ));

      schema.sections.forEach((section) => {
        const part = detail.parts.find((entry) => entry.section === section.id);
        if (part) blocks.push(chapterFieldset(`Chapters in ${section.label}`, section.id, part));
      });
    } else {
      let part = detail.parts.find((entry) => entry.section === "");
      if (!part) {
        part = { section: "", chapters: [] };
        detail.parts.push(part);
      }
      blocks.push(chapterFieldset("Chapters", "", part));
    }
  }

  wrap.replaceChildren(...blocks);
  syncGeneratedName();

  if (activeId) {
    const restored = document.getElementById(activeId);
    if (restored) restored.focus();
  }
}

/** Keeps the name field in step with the choices, until the reader edits it. */
function syncGeneratedName() {
  const generated = buildTaskName(state.form.subject, state.form.detail);
  // An untouched field always mirrors the current choices, including when
  // those choices stop generating a name -- otherwise switching from a subject
  // that names itself to one that does not would leave the old name behind.
  if (!state.form.titleDirty) $("task-title").value = generated;
  $("task-title-hint").hidden = !generated;
}

function onFormChange(event) {
  const target = event.target;
  const detail = state.form.detail;

  if (target.name === "subject") {
    state.form.subject = target.value;
    state.form.detail = emptyFormDetail();
    renderDetailSteps();
    const schema = detailSchema(target.value);
    announce(schema
      ? `${SUBJECTS[target.value].label} selected. ${schema.kindLegend}`
      : `${SUBJECTS[target.value].label} selected.`);
    return;
  }

  if (target.name === "detail-kind") {
    detail.kind = target.value;
    if (!kindTakesChapters(detailSchema(state.form.subject), target.value)) detail.parts = [];
    renderDetailSteps();
    return;
  }

  if (target.name === "detail-section") {
    if (target.checked) {
      if (!detail.parts.some((part) => part.section === target.value)) {
        detail.parts.push({ section: target.value, chapters: [] });
      }
    } else {
      state.form.detail.parts = detail.parts.filter((part) => part.section !== target.value);
    }
    renderDetailSteps();
    return;
  }

  if (target.type === "checkbox" && target.dataset.chapterSection !== undefined) {
    const part = detail.parts.find((entry) => entry.section === target.dataset.chapterSection);
    if (!part) return;
    const chapter = Number(target.value);
    if (target.checked) {
      if (!part.chapters.includes(chapter)) part.chapters.push(chapter);
    } else {
      part.chapters = part.chapters.filter((n) => n !== chapter);
    }
    part.chapters.sort((x, y) => x - y);
    syncGeneratedName();
  }
}

function onFormClick(event) {
  const button = event.target.closest("[data-chapter-action]");
  if (!button) return;
  const part = state.form.detail.parts.find((entry) => entry.section === button.dataset.chapterSection);
  if (!part) return;
  part.chapters = button.dataset.chapterAction === "all"
    ? Array.from({ length: CHAPTER_MAX }, (unused, index) => index + 1)
    : [];
  renderDetailSteps();
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
  $("task-subject-error").textContent = "";
}

function openTaskDialog({ id = null, date = null, time = null, subject = null, returnFocus = null } = {}) {
  const dialog = $("task-dialog");
  const task = id ? findTask(id) : null;

  state.editingId = task ? task.id : null;
  state.returnFocus = returnFocus;
  clearFieldErrors();

  $("task-dialog-title").textContent = task ? "Edit task" : "Add a task";
  $("save-task").textContent = task ? "Save changes" : "Add task";
  $("delete-task").hidden = !task;
  $("done-wrap").hidden = !task;

  // titleDirty starts true so building the form does not overwrite the title
  // being restored; the real value is worked out once everything is in place.
  state.form = {
    subject: task ? task.subject : (subject || ""),
    detail: task && task.detail
      ? { kind: task.detail.kind, parts: task.detail.parts.map((part) => ({ ...part, chapters: [...part.chapters] })) }
      : emptyFormDetail(),
    titleDirty: true,
  };

  renderTypeChoice(task ? task.type : FORM_TYPES[0]);
  renderSubjectChoice();
  renderDetailSteps({ keepFocus: false });

  $("task-title").value = task ? task.title : "";
  $("task-notes").value = task ? task.notes : "";
  $("task-time").value = task ? task.time : (time || "");
  $("task-date").value = task ? task.date : date || state.focusDate || todayISO();
  $("task-done").checked = task ? task.done : false;

  // A name the reader wrote themselves must not be overwritten by the
  // generated one; an untouched generated name may keep updating.
  state.form.titleDirty = task
    ? task.title !== buildTaskName(state.form.subject, state.form.detail)
    : false;
  syncGeneratedName();

  openDialog(dialog);
  const firstType = $("type-choice").querySelector("input");
  if (firstType) firstType.focus();
}

function validateTaskForm() {
  clearFieldErrors();
  let firstInvalid = null;

  const title = $("task-title").value.trim();
  if (!title) {
    $("task-title").setAttribute("aria-invalid", "true");
    $("task-title-error").textContent = "Give the task a name so you can recognise it later.";
    firstInvalid = firstInvalid || $("task-title");
  }

  const subject = state.form.subject;
  if (!subject) {
    $("task-subject-error").textContent = "Pick the subject this belongs to.";
    firstInvalid = firstInvalid || $("subject-choice").querySelector("input");
  }

  const schema = detailSchema(subject);
  if (schema && !state.form.detail.kind) {
    firstInvalid = firstInvalid || $("detail-steps").querySelector("input");
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
    type: selectedType ? selectedType.value : FORM_TYPES[0],
    subject,
    detail: schema ? state.form.detail : null,
    time: $("task-time").value || "",
    // course carries the plain label the rest of the interface already shows.
    course: subject ? SUBJECTS[subject].label : "",
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
    touch(existing);
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
  // Kept as a tombstone, so the deletion survives a merge from another device
  // instead of the task reappearing.
  task.deleted = true;
  touch(task);
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
  if (target === "lesson" && state.view === "week"
      && focusLesson(state.lessonFocus.day, state.lessonFocus.period)) {
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
  touch(task);
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

/*
  Homework and Test are always offered. The two retired types appear only while
  tasks created before the form changed still use them, so the panel never
  shows a filter that cannot match anything.
*/
function neededFilterTypes() {
  const used = new Set(state.tasks.map((task) => task.type));
  return TYPE_KEYS.filter((key) => FORM_TYPES.includes(key) || used.has(key));
}

function renderTypeFilters() {
  const keys = neededFilterTypes();
  const wrap = $("type-filters");
  if (wrap.dataset.keys === keys.join(",")) return;   // avoid stealing focus
  wrap.dataset.keys = keys.join(",");

  wrap.replaceChildren(
    el("legend", { class: "sr-only", text: "Task types to show" }),
    ...keys.map((key) => el(
      "label",
      { class: "check" },
      el("input", {
        type: "checkbox", class: "type-filter", value: key,
        checked: state.typeFilter.includes(key),
      }),
      el("span", { class: `glyph glyph-${key}`, "aria-hidden": "true" }),
      " ",
      TYPES[key].plural
    ))
  );
}

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

/* ---------- Reminders ---------- */

/*
  There is no server, and the web has no way to schedule a notification for a
  closed page: Notification Triggers was never shipped, and a push has to be
  sent by something. So a reminder becomes due at 17:00 the day before a task,
  and is delivered the first moment the app is open after that -- on load, when
  it returns to the foreground, and once a minute while it is in front.

  Keyed by task and date, so moving a task to a new day arms it again.
*/

function reminderKey(task) {
  return `${task.id}:${task.date}`;
}

function reminderTimeFor(task) {
  const when = fromISO(addDays(task.date, -1));
  when.setHours(REMINDER_HOUR, 0, 0, 0);
  return when.getTime();
}

function sentReminders() {
  const stored = readStore(REMINDERS_KEY, {});
  return stored && typeof stored === "object" ? stored : {};
}

function notificationsSupported() {
  return typeof window.Notification === "function";
}

function notificationsOn() {
  return notificationsSupported() && window.Notification.permission === "granted";
}

/** iOS only shows notifications raised through the service worker. */
async function showNotification(title, options) {
  if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
    const registration = await navigator.serviceWorker.ready;
    return registration.showNotification(title, options);
  }
  return new window.Notification(title, options);
}

/**
 * Tasks whose reminder has come due and not yet been delivered. A reminder for
 * something already past its due date is dropped rather than shown late.
 */
function dueReminders(now = Date.now()) {
  const today = todayISO();
  const sent = sentReminders();
  return liveTasks()
    .filter((task) => !task.done && task.date >= today)
    .filter((task) => reminderTimeFor(task) <= now)
    .filter((task) => !sent[reminderKey(task)])
    .sort(sortTasks);
}

async function deliverDueReminders() {
  if (!notificationsOn()) return 0;
  const due = dueReminders();
  if (due.length === 0) return 0;

  const sent = sentReminders();
  for (const task of due) {
    const when = task.date === todayISO() ? "today" : relativeDay(task.date, todayISO()).toLowerCase();
    await showNotification(`Remember: ${task.title}`, {
      body: `${subjectLabel(task)} \u00b7 ${TYPES[task.type].label} \u00b7 due ${when}, ${fmtMediumDate.format(fromISO(task.date))}`,
      tag: reminderKey(task),
      icon: "icons/icon-192.png",
      badge: "icons/icon-192.png",
    });
    sent[reminderKey(task)] = new Date().toISOString();
  }
  writeStore(REMINDERS_KEY, sent);
  renderAlertsPanel();
  return due.length;
}

function renderAlertsPanel() {
  const status = $("alerts-status");
  const enable = $("alerts-enable");
  const test = $("alerts-test");
  if (!status) return;

  if (!notificationsSupported()) {
    status.textContent = "Your browser will not offer reminders here. On an iPhone or iPad, add Remembre to your home screen and open it from there.";
    status.classList.add("is-stale");
    enable.hidden = true;
    test.hidden = true;
    return;
  }

  const permission = window.Notification.permission;
  enable.hidden = permission === "granted";
  test.hidden = permission !== "granted";

  if (permission === "granted") {
    const waiting = dueReminders().length;
    status.textContent = waiting > 0
      ? `Reminders are on. ${waiting} waiting to be delivered.`
      : "Reminders are on.";
    status.classList.toggle("is-stale", waiting > 0);
  } else if (permission === "denied") {
    status.textContent = "Reminders are blocked. Turn notifications for Remembre back on in your device settings; the app cannot ask again.";
    status.classList.add("is-stale");
  } else {
    status.textContent = "Reminders are off.";
    status.classList.remove("is-stale");
  }
}

async function enableReminders() {
  if (!notificationsSupported()) return;
  let permission;
  try {
    permission = await window.Notification.requestPermission();
  } catch (err) {
    console.warn("Could not ask for notification permission:", err);
    return;
  }

  renderAlertsPanel();
  if (permission !== "granted") {
    announce("Reminders were not turned on.");
    return;
  }

  await showNotification("Success", {
    body: "Reminders are working. You will get one the day before each task, at 17:00.",
    tag: "remembre-test",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
  });
  announce("Reminders are on, and a test notification has been sent.");
  await deliverDueReminders();
}

async function sendTestNotification() {
  if (!notificationsOn()) return;
  await showNotification("Success", {
    body: "This is a test. Real reminders arrive the day before a task, at 17:00.",
    tag: "remembre-test",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
  });
  announce("Test notification sent.");
}

function setupReminders() {
  renderAlertsPanel();
  $("alerts-enable").addEventListener("click", enableReminders);
  $("alerts-test").addEventListener("click", sendTestNotification);

  deliverDueReminders();
  window.setInterval(deliverDueReminders, REMINDER_POLL_MS);
  // Coming back to the app is the moment a waiting reminder should appear.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) deliverDueReminders();
  });
}

/* ---------- Sync: saving and loading a file ---------- */

function syncState() {
  return readStore(SYNC_KEY, { lastSavedAt: "" });
}

/** How many tasks have changed since the last copy was saved out. */
function pendingChangeCount() {
  const { lastSavedAt } = syncState();
  if (!lastSavedAt) return state.tasks.length;
  return state.tasks.filter((task) => task.updatedAt > lastSavedAt).length;
}

function markSaved() {
  writeStore(SYNC_KEY, { lastSavedAt: new Date().toISOString() });
  renderSyncPanel();
}

function backupPayload() {
  // Tombstones travel too, or a delete on one device would be undone by the
  // next merge from the other.
  return JSON.stringify({ app: "remembre", version: 2, savedAt: new Date().toISOString(), tasks: state.tasks }, null, 2);
}

async function saveCopy() {
  const payload = backupPayload();

  // On iOS the share sheet is the only route into iCloud Drive, and it also
  // offers AirDrop straight to the other device. Build the File synchronously
  // so the call still counts as coming from the tap.
  if (typeof File === "function" && navigator.canShare) {
    const file = new File([payload], BACKUP_FILENAME, { type: "application/json" });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "Remembre" });
        markSaved();
        announce("Copy saved. Load it on your other device to merge.");
        return;
      } catch (err) {
        // Dismissing the sheet is not a failure; anything else falls through
        // to a plain download.
        if (err && err.name === "AbortError") return;
      }
    }
  }

  const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
  const link = el("a", { href: url, download: BACKUP_FILENAME });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  markSaved();
  announce("Copy saved. Load it on your other device to merge.");
}

/**
 * Fold another device's file into this one. Tasks are matched by id and the
 * newer updatedAt wins; anything unknown is added. Importing the same file
 * twice changes nothing, and neither device loses work.
 */
function mergeTasks(incoming) {
  const byId = new Map(state.tasks.map((task) => [task.id, task]));
  const result = { added: 0, updated: 0, removed: 0, unchanged: 0 };

  incoming.forEach((task) => {
    const existing = byId.get(task.id);
    if (!existing) {
      state.tasks.push(task);
      byId.set(task.id, task);
      if (task.deleted) result.unchanged += 1;
      else result.added += 1;
      return;
    }
    if (task.updatedAt > existing.updatedAt) {
      const wasLive = !existing.deleted;
      Object.assign(existing, task);
      if (task.deleted && wasLive) result.removed += 1;
      else result.updated += 1;
    } else {
      result.unchanged += 1;
    }
  });

  return result;
}

function describeMerge({ added, updated, removed, unchanged }) {
  const parts = [];
  if (added) parts.push(`${added} added`);
  if (updated) parts.push(`${updated} updated`);
  if (removed) parts.push(`${removed} removed`);
  if (unchanged) parts.push(`${unchanged} already up to date`);
  return parts.length ? parts.join(", ") : "nothing to change";
}

function loadCopy(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try {
      parsed = JSON.parse(String(reader.result));
    } catch (err) {
      window.alert("That file is not a Remembre copy: it is not valid JSON.");
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

    const result = mergeTasks(incoming);
    saveTasks();
    renderAll();
    const summary = describeMerge(result);
    announce(`Merged from file: ${summary}.`);
    window.alert(`Merged.\n\n${summary}.`);
  };
  reader.onerror = () => window.alert("That file could not be read.");
  reader.readAsText(file);
}

function renderSyncPanel() {
  const { lastSavedAt } = syncState();
  const pending = pendingChangeCount();
  const status = $("sync-status");
  if (!status) return;

  if (!lastSavedAt) {
    status.textContent = liveTasks().length
      ? "Not saved anywhere yet."
      : "Nothing to save yet.";
    status.classList.toggle("is-stale", liveTasks().length > 0);
    return;
  }

  const days = daysBetween(lastSavedAt.slice(0, 10), todayISO());
  const when = days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  status.textContent = pending === 0
    ? `Saved ${when}. Nothing has changed since.`
    : `Saved ${when}. ${pending} ${pending === 1 ? "change" : "changes"} since then.`;
  status.classList.toggle("is-stale", pending > 0);
}

function loadExamples() {
  const today = todayISO();
  const examples = [
    {
      type: "test", subject: "mathematics", date: addDays(today, 7), time: "11:30",
      detail: { kind: "test", parts: [{ section: "core", chapters: [3, 4, 5] }] },
      notes: "Quadratics and simultaneous equations.",
    },
    {
      type: "homework", subject: "mathematics", date: addDays(today, 2),
      detail: { kind: "study", parts: [{ section: "hlai", chapters: [1, 2] }] },
    },
    {
      type: "homework", subject: "economics", date: addDays(today, 3),
      detail: { kind: "self-study", parts: [{ section: "", chapters: [11, 12] }] },
    },
    {
      type: "test", subject: "economics", date: addDays(today, 9), time: "10:00",
      detail: { kind: "practice-paper", parts: [{ section: "", chapters: [1, 2, 3] }] },
    },
    { title: "Essay, chapter 5", type: "homework", subject: "history", date: addDays(today, 1) },
    { title: "Reading, chapters 3 to 4", type: "homework", subject: "english", date: addDays(today, 5) },
    { title: "Vocabulary test", type: "test", subject: "polish", date: addDays(today, 12), time: "14:00" },
    { title: "Field study write-up", type: "homework", subject: "ess", date: addDays(today, 6) },
  ];
  examples.forEach((example) => {
    const title = example.title || buildTaskName(example.subject, example.detail);
    state.tasks.push(normaliseTask({
      ...example,
      title,
      course: SUBJECTS[example.subject].label,
      id: newId(),
      createdAt: new Date().toISOString(),
    }));
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

  $("prev-period").addEventListener("click", () => {
    if (state.view === "week") goToWeek(addDays(state.weekStart, -7));
    else goToPeriod(addMonths(state.periodStart, -1));
  });
  $("next-period").addEventListener("click", () => {
    if (state.view === "week") goToWeek(addDays(state.weekStart, 7));
    else goToPeriod(addMonths(state.periodStart, 1));
  });
  $("go-today").addEventListener("click", () => {
    const today = todayISO();
    state.weekStart = weekStartFor(today);
    goToPeriod(today, { focus: today });
    if (state.view === "week") focusLesson(state.lessonFocus.day, state.lessonFocus.period);
    else if (state.view === "month") focusDayButton(today);
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

  $("type-filters").addEventListener("change", readFilters);
  $("show-done").addEventListener("change", readFilters);

  const timetable = $("timetable-body");
  timetable.addEventListener("keydown", onTimetableKeydown);
  timetable.addEventListener("click", (event) => {
    const button = event.target.closest(".tt-lesson");
    if (!button) return;
    if (button.dataset.openDay) {
      openDayDialog(button.dataset.openDay);
      return;
    }
    state.lessonFocus = { day: Number(button.dataset.day), period: Number(button.dataset.period) };
    openTaskDialog({
      date: button.dataset.date,
      time: button.dataset.time,
      subject: button.dataset.subject || "",
      returnFocus: "lesson",
    });
  });

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

  $("task-form").addEventListener("change", onFormChange);
  $("task-form").addEventListener("click", onFormClick);
  $("task-title").addEventListener("input", () => { state.form.titleDirty = true; });
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

  $("save-copy").addEventListener("click", saveCopy);
  $("load-copy").addEventListener("click", () => $("load-file").click());
  $("load-file").addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) loadCopy(file);
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
      const today = todayISO();
      state.weekStart = weekStartFor(today);
      goToPeriod(today, { focus: today });
      if (state.view === "week") focusLesson(state.lessonFocus.day, state.lessonFocus.period);
      else if (state.view === "month") focusDayButton(today);
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

  setView(["week", "month", "list"].includes(prefs.view) ? prefs.view : "week");
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
  $("app-version").textContent = APP_VERSION;
  state.tasks = loadTasks();
  const today = todayISO();
  state.focusDate = today;
  state.weekStart = weekStartFor(today);
  state.periodStart = today.slice(0, 8) + "01";
  restorePrefs();
  setupEvents();
  renderAll();
  setupReminders();
}

/*
  Register the service worker only for the hosted, installable copy. The
  single-file build has no manifest link and no sw.js beside it, so the check
  below keeps it from logging a failed registration there.

  Because the app is served from its own cache, a deploy is invisible until the
  stored copy is replaced. Rather than let that happen silently underfoot, a
  freshly downloaded version waits, and the reader is offered it.
*/

/** True when this page was already under a worker, so a change of controller
    means an update rather than the very first install. */
let hadController = false;
let reloadingForUpdate = false;

function showUpdateBar(worker) {
  const bar = $("update-bar");
  if (!bar.hidden) return;
  bar.hidden = false;
  announce("A new version of Remembre is ready. Reload to update.");

  $("update-reload").onclick = () => {
    $("update-reload").disabled = true;
    // The worker calls skipWaiting, which changes the controller, and the
    // listener below reloads the page onto the new version.
    worker.postMessage({ type: "SKIP_WAITING" });
  };
  $("update-dismiss").onclick = () => {
    bar.hidden = true;
    announce("Update postponed. It will be applied next time you open Remembre.");
    $("add-task-top").focus();
  };
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (!document.querySelector('link[rel="manifest"]')) return;
  if (!window.isSecureContext) return;

  hadController = Boolean(navigator.serviceWorker.controller);

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // On a first install the controller also changes; only an update reloads.
    if (!hadController || reloadingForUpdate) return;
    reloadingForUpdate = true;
    window.location.reload();
  });

  navigator.serviceWorker.register("sw.js").then((registration) => {
    // A version downloaded on an earlier visit and still waiting.
    if (registration.waiting && navigator.serviceWorker.controller) {
      showUpdateBar(registration.waiting);
    }

    registration.addEventListener("updatefound", () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener("statechange", () => {
        if (installing.state === "installed" && navigator.serviceWorker.controller) {
          showUpdateBar(installing);
        }
      });
    });
  }).catch((err) => {
    console.warn("Offline support is unavailable:", err);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  init();
  registerServiceWorker();
});
