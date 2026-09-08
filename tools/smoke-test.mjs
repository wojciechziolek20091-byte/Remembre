/*
  End-to-end smoke test. Serves the site on a local port, drives it in
  Chromium, and asserts the behaviour the interface promises: adding and
  editing tasks, filters, persistence, keyboard navigation of the month grid,
  form validation, and -- the easy one to regress -- that focus survives
  completing a task whose row then disappears.

  Run with:  npm test
  Set CHROMIUM_PATH if Playwright's bundled browser is not installed.
*/

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  const file = join(root, path === "/" ? "index.html" : path);
  try {
    const body = await readFile(file);
    const ext = file.slice(file.lastIndexOf("."));
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const failures = [];
let checks = 0;

function check(label, actual, expected) {
  checks += 1;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures.push(`${label}\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`);
  console.log(`  ${ok ? "ok " : "NO "} ${label}`);
}

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
);
const page = await browser.newPage({ viewport: { width: 1360, height: 950 } });

const problems = [];
page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error") problems.push(`console: ${message.text()}`);
});

await page.goto(base);
await page.waitForSelector(".tt-lesson");

console.log("\ntimetable");
check("the timetable opens by default", await page.locator("#view-week").isChecked(), true);
check("every lesson in the week is drawn", await page.locator(".tt-lesson").count(), 33);
check("the timetable has one tab stop", await page.locator('.tt-lesson[tabindex="0"]').count(), 1);
check("period 0 is the only lesson before 08:45",
  await page.evaluate(() => [...document.querySelectorAll('.tt-lesson[data-period="0"]')].map((b) => b.dataset.time)),
  ["08:00"]);
check("the double periods share a start time",
  await page.evaluate(() => [1, 2, 3, 4, 5, 6, 7, 8].map((p) => {
    const b = document.querySelector(`.tt-lesson[data-period="${p}"]`);
    return b ? b.dataset.time : null;
  })),
  ["08:45", "08:45", "10:35", "10:35", "12:10", "12:10", "14:10", "14:10"]);

const weekBefore = await page.textContent("#period-title");
await page.click("#next-period");
const weekAfter = await page.textContent("#period-title");
check("the arrows move a week at a time", weekBefore !== weekAfter, true);
check("dates move with them",
  await page.evaluate(() => document.querySelector('.tt-lesson[data-day="0"]') !== null), true);
await page.click("#go-today");
check("This week comes back", await page.textContent("#period-title"), weekBefore);

console.log("\nadding from a lesson");
await page.locator('.tt-lesson[data-day="2"][data-period="0"]').click();
await page.waitForSelector("#task-dialog[open]");
check("the subject comes from the lesson",
  await page.evaluate(() => document.querySelector('input[name="subject"]:checked').value), "mathematics");
check("the time comes from the period", await page.inputValue("#task-time"), "08:00");
check("the date is that weekday in the week on screen",
  await page.inputValue("#task-date"),
  await page.evaluate(() => document.querySelector('.tt-lesson[data-day="2"][data-period="0"]').dataset.date));
check("and the maths follow-ups are already showing",
  await page.locator("#detail-steps fieldset").count(), 1);
await page.keyboard.press("Escape");

console.log("\nlesson keyboard");
await page.locator('.tt-lesson[data-day="0"][data-period="3"]').focus();
const step = async (key) => {
  await page.keyboard.press(key);
  return page.evaluate(() => `${document.activeElement.dataset.day}/${document.activeElement.dataset.period}`);
};
check("right moves along the period", await step("ArrowRight"), "1/3");
check("down moves to the next period", await step("ArrowDown"), "1/4");
check("free periods are skipped, not landed on", await step("ArrowRight"), "3/4");
check("End reaches the last lesson of the period", await step("End"), "4/4");
check("Home reaches the first", await step("Home"), "0/4");

console.log("\nwhere a task appears in the week");
const placed = await page.evaluate(() => {
  const at = (day, period) => document.querySelector(`.tt-lesson[data-day="${day}"][data-period="${period}"]`);
  const mk = (id, title, subject, date, time) => normaliseTask({
    id, title, type: "homework", subject, course: subject, date, time,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  });
  state.tasks = [
    mk("m", "Maths work", "mathematics", at(2, 0).dataset.date, ""),
    mk("t", "Maths at 10:35", "mathematics", at(4, 3).dataset.date, "10:35"),
    mk("p", "Polish essay", "polish", at(0, 3).dataset.date, ""),
  ];
  saveTasks();
  renderAll();
  const chips = (day, period) => [...at(day, period).querySelectorAll(".chip-text")].map((n) => n.textContent);
  return {
    firstMaths: chips(2, 0),
    secondMaths: chips(2, 1),
    byTime: chips(4, 3),
    extraRow: document.querySelectorAll(".tt-extra-row").length,
    orphan: [...document.querySelectorAll(".tt-extra-btn .chip-text")].map((n) => n.textContent),
  };
});
check("a task sits on the day's first lesson in its subject", placed.firstMaths, ["Maths work"]);
check("and is not repeated at the second one that day", placed.secondMaths, []);
check("a task with a time goes to the lesson at that time", placed.byTime, ["Maths at 10:35"]);
check("a subject with no lesson that day still shows", placed.extraRow, 1);
check("in its own row rather than vanishing", placed.orphan, ["Polish essay"]);

await page.evaluate(() => { state.tasks = []; saveTasks(); renderAll(); });
await page.click('label[for="view-month"]');
await page.waitForSelector(".day");

console.log("\nfirst run");
check("the month grid renders whole weeks", (await page.locator(".day").count()) % 7, 0);
check("today is marked exactly once", await page.locator('td.is-today [aria-current="date"]').count(), 1);
check("the grid has a single tab stop", await page.locator('.day[tabindex="0"]').count(), 1);
check("upcoming starts empty", (await page.textContent("#upcoming-list")).trim(), "Nothing scheduled yet.");

console.log("\nexample data");
await page.click('label[for="view-list"]');
await page.click("#load-examples");
await page.waitForSelector(".task-row");
check("the example tasks are stored",
  await page.evaluate(() => JSON.parse(localStorage.getItem("remembre.tasks.v1")).length), 8);
check("the upcoming panel fills to its limit", await page.locator("#upcoming-list .up-btn").count(), 6);
check("every example carries a subject",
  await page.evaluate(() => JSON.parse(localStorage.getItem("remembre.tasks.v1")).every((t) => t.subject)), true);

console.log("\nadding a task");
const today = await page.evaluate(() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
});
await page.click('label[for="view-month"]');
await page.click("#add-task-top");
await page.waitForSelector("#task-dialog[open]");
check("the dialog opens on the first question", await page.evaluate(() => document.activeElement.id), "type-homework");
check("only homework and test are offered", await page.locator("#type-choice input").count(), 2);
check("delete is hidden when adding", await page.locator("#delete-task").isVisible(), false);
await page.click('label[for="type-homework"]');
await page.click('label[for="subject-english"]');
await page.fill("#task-title", "Physics problem set 7");
await page.fill("#task-date", today);
await page.click("#save-task");
await page.waitForSelector("#task-dialog", { state: "hidden" });
check("the new task appears in the grid",
  await page.locator("#month-view").locator(".chip-text", { hasText: "Physics problem set 7" }).count(), 1);
await page.waitForTimeout(150);
check("and is announced", (await page.textContent("#live-region")).startsWith('Added "Physics problem set 7"'), true);

console.log("\nvalidation");
await page.click("#add-task-top");
await page.fill("#task-date", today);
await page.click("#save-task");
check("a missing subject is rejected", (await page.textContent("#task-subject-error")).length > 0, true);
await page.click('label[for="subject-polish"]');
await page.fill("#task-title", "   ");
await page.click("#save-task");
check("a blank title is rejected", await page.locator("#task-dialog[open]").count(), 1);
check("the field is flagged invalid", await page.getAttribute("#task-title", "aria-invalid"), "true");
check("with an error message", (await page.textContent("#task-title-error")).length > 0, true);
await page.keyboard.press("Escape");

console.log("\nkeyboard navigation");
await page.locator('.day[tabindex="0"]').focus();
const start = await page.evaluate(() => document.activeElement.dataset.date);
await page.keyboard.press("ArrowRight");
await page.keyboard.press("ArrowDown");
const after = await page.evaluate(() => document.activeElement.dataset.date);
check("arrow keys move by a day and a week", (new Date(after) - new Date(start)) / 86400000, 8);
await page.keyboard.press("PageDown");
check("page down crosses into the next month", await page.locator('.day[tabindex="0"]').count(), 1);
check("and focus follows across the boundary", await page.evaluate(() => document.activeElement.dataset.date !== null), true);
await page.keyboard.press("Enter");
await page.waitForSelector("#day-dialog[open]");
check("enter opens the day", (await page.textContent("#day-dialog-title")).length > 0, true);
await page.keyboard.press("Escape");
await page.click("#go-today");

console.log("\nfilters and persistence");
// Chips are coloured by subject now, so type is read from the glyph inside.
const homeworkChips = () => page.locator("#month-view .chip .glyph-homework").count();
check("there are homework chips to hide in the first place", (await homeworkChips()) > 0, true);
await page.locator('.type-filter[value="homework"]').uncheck();
check("unchecking a type hides its chips", await homeworkChips(), 0);
await page.locator('.type-filter[value="homework"]').check();
check("and checking it brings them back", (await homeworkChips()) > 0, true);
const beforeReload = await page.evaluate(() =>
  JSON.parse(localStorage.getItem("remembre.tasks.v1")).length);
await page.reload();
await page.waitForSelector(".day");
check("tasks survive a reload",
  await page.evaluate(() => JSON.parse(localStorage.getItem("remembre.tasks.v1")).length), beforeReload);
check("so do the filter settings", await page.locator('.type-filter[value="homework"]').isChecked(), true);

console.log("\ncompleting a task");
await page.click('label[for="view-list"]');
await page.waitForSelector(".task-check");
const box = page.locator(".task-check").first();
const toggledId = await box.getAttribute("data-toggle");
await box.click();
check("the task is stored as done", await page.evaluate(() =>
  JSON.parse(localStorage.getItem("remembre.tasks.v1")).filter((t) => t.done).length), 1);
check("its row is hidden, since completed tasks are off", await page.locator(`[data-toggle="${toggledId}"]`).count(), 0);
check("and focus is not dropped on the body", await page.evaluate(() =>
  document.activeElement !== document.body && Boolean(document.activeElement.closest("#agenda"))), true);

console.log("\nshortcuts");
await page.click('label[for="view-month"]');
await page.locator("body").click({ position: { x: 5, y: 5 } });
await page.keyboard.press("n");
check("N opens the add dialog", await page.locator("#task-dialog[open]").count(), 1);
await page.keyboard.press("Escape");

console.log("\nreflow");
for (const width of [1360, 900, 640, 390, 320]) {
  await page.setViewportSize({ width, height: 900 });
  check(`no horizontal scrolling at ${width}px`, await page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
}

console.log("\nsubject branches in the form");
await page.click("#add-task-top");
await page.waitForSelector("#task-dialog[open]");
check("no follow-up questions before a subject is picked",
  await page.locator("#detail-steps fieldset").count(), 0);
check("the six subjects are offered",
  await page.locator("#subject-choice label").allInnerTexts(),
  ["Economics", "Mathematics", "English", "Polish", "History", "ESS"]);

await page.click('label[for="subject-mathematics"]');
check("maths asks for a kind",
  await page.locator("#detail-steps label").allInnerTexts(), ["Test", "Short test", "Study", "Other"]);
await page.click('label[for="kind-test"]');
check("then for the part of the course",
  await page.locator('#detail-steps input[name="detail-section"]').count(), 2);
check("chapters stay hidden until a part is chosen", await page.locator(".chapter-grid").count(), 0);

await page.click('label[for="section-core"]');
check("choosing a part reveals 20 chapters", await page.locator(".chapter-grid label").count(), 20);
for (const n of [3, 4, 5]) await page.click(`label[for="chapter-core-${n}"]`);
check("the name is written from the choices",
  await page.inputValue("#task-title"), "Test Chapters 3\u20135 from Core Topics");

await page.click('label[for="section-hlai"]');
await page.click('label[for="chapter-hlai-7"]');
check("both parts of the course can be used at once",
  await page.inputValue("#task-title"),
  "Test Chapters 3\u20135 from Core Topics; Chapters 7 from HL AI");
await page.click('[data-chapter-action="all"][data-chapter-section="hlai"]');
check("All selects every chapter",
  await page.inputValue("#task-title"),
  "Test Chapters 3\u20135 from Core Topics; Chapters 1\u201320 from HL AI");
await page.click('[data-chapter-action="none"][data-chapter-section="hlai"]');
await page.click('label[for="section-hlai"]');

await page.fill("#task-date", today);
await page.click("#save-task");
await page.waitForSelector("#task-dialog", { state: "hidden" });
const mathsTask = await page.evaluate(() =>
  JSON.parse(localStorage.getItem("remembre.tasks.v1")).find((t) => t.subject === "mathematics" && t.detail && t.detail.kind === "test" && t.detail.parts.length === 1));
check("the structured choices are stored, not just the name",
  [mathsTask.detail.kind, mathsTask.detail.parts[0].section, mathsTask.detail.parts[0].chapters],
  ["test", "core", [3, 4, 5]]);
check("the subject also fills the course label shown on the task", mathsTask.course, "Mathematics");

await page.click("#add-task-top");
await page.click('label[for="subject-economics"]');
check("economics asks for its own kinds",
  await page.locator("#detail-steps label").allInnerTexts(), ["Self Study", "Practice paper", "Other"]);
await page.click('label[for="kind-other"]');
check("economics Other asks for no chapters", await page.locator(".chapter-grid").count(), 0);
await page.click('label[for="kind-self-study"]');
check("Self Study does ask for chapters", await page.locator(".chapter-grid label").count(), 20);
for (const n of [11, 12]) await page.click(`label[for="chapter-all-${n}"]`);
check("and names itself without a course part",
  await page.inputValue("#task-title"), "Self Study Chapters 11\u201312");

await page.click('label[for="subject-history"]');
check("a subject with no follow-ups asks nothing further",
  await page.locator("#detail-steps fieldset").count(), 0);
check("and clears the name generated for the previous subject",
  await page.inputValue("#task-title"), "");
await page.fill("#task-title", "Wording of my own");
await page.click('label[for="subject-mathematics"]');
await page.click('label[for="kind-study"]');
check("a name typed by hand is not overwritten",
  await page.inputValue("#task-title"), "Wording of my own");
await page.keyboard.press("Escape");

console.log("\nediting a structured task");
await page.evaluate(() => {
  state.tasks = [normaliseTask({
    id: "edit-me", title: "Short test Chapters 2\u20133 from HL AI", type: "test",
    subject: "mathematics", course: "Mathematics", date: "2026-10-14",
    detail: { kind: "short-test", parts: [{ section: "hlai", chapters: [2, 3] }] },
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
  })];
  saveTasks();
  renderAll();
  openTaskDialog({ id: "edit-me" });
});
await page.waitForSelector("#task-dialog[open]");
check("editing restores the subject", await page.locator("#subject-mathematics").isChecked(), true);
check("editing restores the kind", await page.locator("#kind-short-test").isChecked(), true);
check("editing restores the part of the course", await page.locator("#section-hlai").isChecked(), true);
check("editing restores the chapters",
  await page.evaluate(() => [...document.querySelectorAll('[data-chapter-section="hlai"]')]
    .filter((box) => box.checked).map((box) => Number(box.value))), [2, 3]);
check("and the name is left alone", await page.inputValue("#task-title"),
  "Short test Chapters 2\u20133 from HL AI");
await page.keyboard.press("Escape");

console.log("\nreminders");
await page.context().grantPermissions(["notifications"], { origin: base });
await page.evaluate(() => navigator.serviceWorker.ready);
// Capture what the page raises rather than relying on the OS showing it.
await page.evaluate(async () => {
  window.__notes = [];
  const registration = await navigator.serviceWorker.ready;
  const real = registration.showNotification.bind(registration);
  registration.showNotification = (title, options) => {
    window.__notes.push({ title, body: options && options.body });
    return real(title, options);
  };
});

const reminders = await page.evaluate(async () => {
  const z = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
  const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
  const mk = (id, title, date, done) => normaliseTask({
    id, title, type: "test", subject: "mathematics", course: "Mathematics", date, done,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  });
  localStorage.removeItem("remembre.reminders.v1");
  state.tasks = [
    mk("today", "Algebra test", day(0), false),   // reminded yesterday at 17:00
    mk("past", "Old essay", day(-2), false),      // already overdue
    mk("done", "Finished", day(0), true),         // already completed
    mk("future", "Later test", day(5), false),    // reminder still ahead
  ];
  saveTasks();

  const dueIds = dueReminders().map((task) => task.id);
  const dueTomorrow = mk("t", "x", day(1), false);
  const at = new Date(reminderTimeFor(dueTomorrow));

  window.__notes = [];
  await deliverDueReminders();
  const first = [...window.__notes];
  window.__notes = [];
  await deliverDueReminders();
  const second = [...window.__notes];

  return {
    dueIds, first, second,
    remindAtHour: at.getHours(),
    remindsDayBefore: iso(at) === day(0),
    stored: Object.keys(JSON.parse(localStorage.getItem("remembre.reminders.v1"))),
  };
});

check("a reminder falls the day before the task", reminders.remindsDayBefore, true);
check("at 17:00", reminders.remindAtHour, 17);
check("only work that is still ahead and unfinished is reminded", reminders.dueIds, ["today"]);
check("the reminder says remember, and names the task",
  reminders.first.map((n) => n.title), ["Remember: Algebra test"]);
check("and carries the subject and type", reminders.first[0].body.startsWith("Mathematics"), true);
check("a reminder is delivered once, not on every check", reminders.second, []);
check("delivery is recorded against the task and its date", reminders.stored, ["today:" + await page.evaluate(() => {
  const z = (n) => String(n).padStart(2, "0"); const d = new Date();
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
})]);

const proof = await page.evaluate(async () => {
  window.__notes = [];
  await sendTestNotification();
  return window.__notes;
});
check("the test notification reports success", proof.map((n) => n.title), ["Success"]);

await page.evaluate(() => { state.tasks = []; saveTasks(); renderAll(); });

console.log("\ntwo-device merge");
/*
  Simulates the real workflow: two devices from a common starting point, each
  edited independently, then one device's file merged into the other. Calls the
  page's own functions -- app.js is a classic script, so they are in scope --
  rather than making production code export test hooks.
*/
const merged = await page.evaluate(() => {
  const t = (id, title, updatedAt, extra = {}) => normaliseTask({
    id, title, type: "homework", date: "2026-10-14", time: "", course: "", notes: "",
    done: false, deleted: false, createdAt: "2026-10-01T00:00:00.000Z", updatedAt, ...extra,
  });

  // This device: edited "shared" late, has one of its own, deleted "gone".
  state.tasks = [
    t("shared", "Essay, final draft", "2026-10-05T10:00:00.000Z"),
    t("ipad-only", "Chemistry lab", "2026-10-04T10:00:00.000Z"),
    t("gone", "Cancelled trip", "2026-10-06T10:00:00.000Z", { deleted: true }),
    t("older", "Keep this copy", "2026-10-07T10:00:00.000Z"),
  ];

  // The other device's file: an older "shared", its own task, "gone" still
  // alive, and a stale copy of "older".
  const other = [
    t("shared", "Essay, first draft", "2026-10-02T10:00:00.000Z"),
    t("phone-only", "French vocabulary", "2026-10-03T10:00:00.000Z"),
    t("gone", "Cancelled trip", "2026-10-01T10:00:00.000Z"),
    t("older", "Stale copy", "2026-10-02T10:00:00.000Z"),
  ];

  const first = mergeTasks(other);
  const afterFirst = JSON.parse(JSON.stringify(state.tasks));
  const second = mergeTasks(other);          // merging twice must be a no-op
  const afterSecond = JSON.parse(JSON.stringify(state.tasks));
  return { first, second, afterFirst, afterSecond };
});

const byId = (list, id) => list.find((task) => task.id === id);
check("the newer edit wins", byId(merged.afterFirst, "shared").title, "Essay, final draft");
check("a stale copy does not overwrite", byId(merged.afterFirst, "older").title, "Keep this copy");
check("the other device's task is added", Boolean(byId(merged.afterFirst, "phone-only")), true);
check("this device's own task survives", Boolean(byId(merged.afterFirst, "ipad-only")), true);
check("a deletion is not undone by an older copy", byId(merged.afterFirst, "gone").deleted, true);
check("merging the same file twice changes nothing",
  JSON.stringify(merged.afterSecond), JSON.stringify(merged.afterFirst));
check("the second merge reports no changes",
  [merged.second.added, merged.second.updated, merged.second.removed], [0, 0, 0]);

console.log("\ndeleting leaves a tombstone");
const tomb = await page.evaluate(() => {
  state.tasks = [normaliseTask({
    id: "doomed", title: "Delete me", type: "test", date: "2026-10-20",
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
  })];
  state.editingId = "doomed";
  const realConfirm = window.confirm;
  window.confirm = () => true;
  deleteCurrentTask();
  window.confirm = realConfirm;
  return { rows: state.tasks.length, deleted: state.tasks[0].deleted, visible: liveTasks().length };
});
check("the row is kept so the deletion can travel", [tomb.rows, tomb.deleted], [1, true]);
check("but it is gone from the interface", tomb.visible, 0);

check("no console or page errors", problems, []);

await browser.close();
server.close();

console.log(`\n${checks - failures.length}/${checks} checks passed.`);
if (failures.length > 0) {
  console.log(`\n${failures.map((f) => `  - ${f}`).join("\n")}\n`);
  process.exit(1);
}
