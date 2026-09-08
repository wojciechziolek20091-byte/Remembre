/*
  The two-device test. Serves the site and the real sync routes together, then
  drives two independent browser contexts -- an iPad and a phone, as far as the
  app can tell -- and checks that work added on one turns up on the other
  without anybody saving or loading a file, and that the calendar address a
  calendar app would subscribe to carries the same deadlines.

  Run with:  npm test
  Set CHROMIUM_PATH if Playwright's bundled browser is not installed.
*/

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const store = await mkdtemp(join(tmpdir(), "remembre-sync-"));
process.env.REMEMBRE_DATA_DIR = store;

const [{ default: syncRoute }, { default: calendarRoute }, { default: statusRoute }] =
  await Promise.all([
    import("../api/sync.js"),
    import("../api/calendar.js"),
    import("../api/status.js"),
  ]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^(\.\.[/\\])+/, "");

  // The same two routes vercel.json publishes, so the test exercises the URL
  // the reader's calendar app will actually be given.
  const subscription = path.match(/^\/calendar\/([a-f0-9]{32})\.ics$/);
  if (subscription) {
    req.url = `/api/calendar?feed=${subscription[1]}`;
    return void calendarRoute(req, res);
  }
  if (path === "/api/sync") return void syncRoute(req, res);
  if (path === "/api/calendar") return void calendarRoute(req, res);
  if (path === "/api/status") return void statusRoute(req, res);

  try {
    const file = join(root, path === "/" ? "index.html" : path);
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

const problems = [];

/** A device is its own browser context: its own storage, its own worker. */
async function openDevice(name) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 950 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => problems.push(`${name} pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`${name} console: ${message.text()}`);
  });
  await page.goto(base);
  await page.waitForSelector(".tt-lesson");
  return { context, page };
}

const PHRASE = "quiet-cherry-mornings";

async function connect(page, phrase = PHRASE) {
  await page.fill("#cloud-code", phrase);
  await page.click("#cloud-connect");
}

/** The app announces through a live region; waiting on the panel is steadier. */
const statusOf = (page) => page.locator("#cloud-status").textContent();

async function waitForSynced(page) {
  await page.waitForFunction(
    () => /^Synced/.test(document.getElementById("cloud-status").textContent),
    null,
    { timeout: 15000 }
  );
}

/** Adds a task the way the dialog would, then lets the debounce carry it up. */
async function addTask(page, title, date) {
  await page.evaluate(([title, date]) => {
    const now = new Date().toISOString();
    state.tasks.push(normaliseTask({
      id: `test-${title.toLowerCase().replace(/\W+/g, "-")}`,
      title, date, time: "", type: "homework", subject: "history",
      done: false, createdAt: now, updatedAt: now,
    }));
    saveTasks();
    renderAll();
  }, [title, date]);
}

const titlesOn = (page) => page.evaluate(() => liveTasks().map((t) => t.title).sort());

/* ---------- Before anything is turned on ---------- */

console.log("\nbefore syncing is turned on");

const ipad = await openDevice("ipad");
{
  check("the panel offers to turn syncing on", await ipad.page.locator("#cloud-setup").isVisible(), true);
  check("and hides the live half", await ipad.page.locator("#cloud-live").isVisible(), false);
  check("and says this device is alone", await statusOf(ipad.page), "Not syncing. This device is on its own.");
}

{
  await connect(ipad.page, "too-short");
  check(
    "a short phrase is refused before anything is sent",
    await statusOf(ipad.page),
    "A sync phrase needs at least 12 characters."
  );
  check("and syncing stays off", await ipad.page.locator("#cloud-setup").isVisible(), true);
}

/* ---------- Turning it on ---------- */

console.log("\nturning it on");

await connect(ipad.page);
await waitForSynced(ipad.page);

const feedUrl = await ipad.page.inputValue("#cloud-feed");
{
  // Syncing does by itself what these two panels ask the reader to do by hand,
  // so they go away rather than inviting duplicated work.
  check("the save-and-load panel goes away", await ipad.page.locator("#sync-panel").isVisible(), false);
  check("and so does the export-a-file half of the calendar panel",
    await ipad.page.locator("#calendar-export").isVisible(), false);
  check("but the timetable alarms switch stays",
    await ipad.page.locator("#lesson-alerts").isVisible(), true);
  check("and saving a copy is still reachable from the footer",
    await ipad.page.locator("#backup-note").isVisible(), true);
}
{
  check("the setup half gives way to the live one", await ipad.page.locator("#cloud-live").isVisible(), true);
  check("a calendar address is offered", /\/calendar\/[a-f0-9]{32}\.ics$/.test(feedUrl), true);
  check("the phrase is not in the address", feedUrl.includes(PHRASE), false);
  check(
    "the phrase is not left sitting in the field",
    await ipad.page.inputValue("#cloud-code"),
    ""
  );
}

/* ---------- One device's work reaches the other ---------- */

console.log("\nfrom the iPad to the phone");

await addTask(ipad.page, "Cold War essay", "2026-09-25");
{
  check(
    "a change is queued rather than sent at once",
    await statusOf(ipad.page),
    "Changes will be sent in a moment."
  );
}
await waitForSynced(ipad.page);
check("and goes up on its own, with no button pressed", /^Synced/.test(await statusOf(ipad.page)), true);

const phone = await openDevice("phone");
await connect(phone.page, PHRASE);
await waitForSynced(phone.page);
{
  check("the phone finds the iPad's work", await titlesOn(phone.page), ["Cold War essay"]);
  check(
    "and lands on the same calendar address",
    await phone.page.inputValue("#cloud-feed"),
    feedUrl
  );
}

/* ---------- And back the other way ---------- */

console.log("\nand back again");

await addTask(phone.page, "Maths problem set", "2026-09-22");
await waitForSynced(phone.page);

await ipad.page.click("#cloud-now");
await waitForSynced(ipad.page);
{
  check(
    "the iPad picks up the phone's work",
    await titlesOn(ipad.page),
    ["Cold War essay", "Maths problem set"]
  );
  check(
    "and nothing of its own was lost",
    await titlesOn(phone.page),
    ["Cold War essay", "Maths problem set"]
  );
}

/* ---------- A deletion travels too ---------- */

console.log("\na deletion travels");

await ipad.page.evaluate(() => {
  const doomed = liveTasks().find((task) => task.title === "Maths problem set");
  doomed.deleted = true;
  doomed.updatedAt = new Date().toISOString();
  saveTasks();
  renderAll();
});
await waitForSynced(ipad.page);

await phone.page.click("#cloud-now");
await waitForSynced(phone.page);
check("the phone lets it go as well", await titlesOn(phone.page), ["Cold War essay"]);

/* ---------- The calendar subscription ---------- */

console.log("\nthe calendar address");

{
  const res = await fetch(feedUrl);
  const text = await res.text();
  check("subscribing to it works", res.status, 200);
  check("it is served as a calendar", (res.headers.get("content-type") || "").startsWith("text/calendar"), true);
  check("it carries the surviving deadline", text.includes("Cold War essay"), true);
  check("and not the deleted one", text.includes("Maths problem set"), false);
  check("with the day-before alarm still on it", text.includes("BEGIN:VALARM"), true);
}

{
  // The "your calendar is N changes behind" nag belonged to exporting a file
  // by hand. A subscription cannot fall behind, so the whole thing is gone
  // rather than reassuring the reader about something it no longer does.
  check(
    "with the subscription live, there is nothing to chase",
    await ipad.page.locator("#calendar-export").isVisible(),
    false
  );
}

/* ---------- Reopening the app ---------- */

console.log("\nreopening the app");

await phone.page.evaluate(() => {
  const task = liveTasks().find((t) => t.title === "Cold War essay");
  task.title = "Cold War essay, final";
  task.updatedAt = new Date().toISOString();
  saveTasks();
});
await waitForSynced(phone.page);

await ipad.page.reload();
await ipad.page.waitForSelector(".tt-lesson");
await waitForSynced(ipad.page);
{
  check("syncing is still on after a reload", await ipad.page.locator("#cloud-live").isVisible(), true);
  check("and it catches up by itself", await titlesOn(ipad.page), ["Cold War essay, final"]);
}

/* ---------- Turning it off ---------- */

console.log("\nturning it off");

ipad.page.once("dialog", (dialog) => dialog.accept());
await ipad.page.click("#cloud-off");
{
  check("the panel offers to start again", await ipad.page.locator("#cloud-setup").isVisible(), true);
  check("and says so", await statusOf(ipad.page), "Not syncing. This device is on its own.");
  check("saving and loading a file comes back", await ipad.page.locator("#sync-panel").isVisible(), true);
  check("and so does exporting a calendar", await ipad.page.locator("#calendar-export").isVisible(), true);
  check("and the footer shortcut goes", await ipad.page.locator("#backup-note").isVisible(), false);
  check("the work stays on the device", await titlesOn(ipad.page), ["Cold War essay, final"]);
}

await addTask(ipad.page, "Not shared", "2026-09-28");
await ipad.page.waitForTimeout(5500);
await phone.page.click("#cloud-now");
await waitForSynced(phone.page);
check("and nothing more is sent up", await titlesOn(phone.page), ["Cold War essay, final"]);

/* ---------- Done ---------- */

check("no console or page errors", problems, []);

await browser.close();
server.close();
await rm(store, { recursive: true, force: true });

if (failures.length) {
  console.error(`\n${failures.length} failed:\n` + failures.map((f) => `  - ${f}`).join("\n\n"));
  process.exit(1);
}
console.log(`\n${checks}/${checks} checks passed.`);
