/*
  The one piece of arithmetic that exists twice.

  The page works out what a day is allowed so it can draw it; the server works
  the same thing out so it can decide whether to interrupt an afternoon about
  it. They cannot share a module -- one is a classic script with no build step,
  the other an ES module on a serverless function -- so both are run here over
  the same fixtures and compared to the grosz.

  If this fails, the page and the phone are telling the reader different
  numbers, which is worse than either of them being wrong.

  Run: node tools/budget-test.mjs
*/

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

import * as server from "../api/_budget.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed += 1;
  else failures.push(`${label}\n      page:   ${JSON.stringify(actual)}\n      server: ${JSON.stringify(expected)}`);
  console.log(`  ${ok ? "ok " : "NO "} ${label}`);
}

/* ---------- The fixtures ---------- */

const SETTINGS = {
  budgets: "food = 620\ncoffee = 200\ntransport = 140\nfun = 150\nsubscriptions = 150",
  rules: "",
  income: "1 = 700\n8 = 600\n15 = 600\n22 = 600",
};

const tx = (date, amount, category = "food", extra = {}) => ({
  id: `${date}-${amount}-${category}`, date, amount, category,
  counterparty: "ZABKA", branch: "", deleted: false, ...extra,
});

const CASES = [
  {
    name: "a quiet week",
    rows: [tx("2026-10-05", -1000), tx("2026-10-06", -1200), tx("2026-10-07", -900), tx("2026-10-08", -1100)],
    on: "2026-10-09",
  },
  {
    name: "a loud week",
    rows: [tx("2026-10-05", -9000), tx("2026-10-06", -8000), tx("2026-10-07", -7000), tx("2026-10-08", -6000)],
    on: "2026-10-09",
  },
  {
    name: "a weekend day",
    rows: [tx("2026-10-09", -4000), tx("2026-10-10", -3000)],
    on: "2026-10-10",
  },
  {
    name: "nothing spent at all",
    rows: [tx("2026-10-01", -100)],
    on: "2026-10-14",
  },
  {
    name: "a month that starts on a Sunday",
    rows: [tx("2026-11-02", -2500), tx("2026-11-03", -2500)],
    on: "2026-11-04",
  },
  {
    name: "money outside the plan, which is nobody's business",
    rows: [tx("2026-10-06", -1000), tx("2026-10-06", -50000, "fun", { branch: "external" }),
      tx("2026-10-06", -30000, "transfers")],
    on: "2026-10-07",
  },
  {
    name: "a payment with no budget behind it",
    rows: [tx("2026-10-07", -4500, "clothes"), tx("2026-10-07", -1000)],
    on: "2026-10-07",
  },
  {
    name: "one enormous day in a quiet week",
    rows: [tx("2026-10-05", -300), tx("2026-10-06", -20000), tx("2026-10-07", -300)],
    on: "2026-10-08",
  },
  {
    name: "a run of days over the rate",
    rows: [tx("2026-10-06", -9000), tx("2026-10-07", -9000), tx("2026-10-08", -9000)],
    on: "2026-10-08",
  },
  {
    name: "spending taken out of savings",
    rows: [tx("2026-10-07", -40000, "fun", { branch: "savings" }), tx("2026-10-07", -1000)],
    on: "2026-10-07",
  },
];

/* ---------- The page's copy ---------- */

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2",
  ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json" };

const site = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  if (path.startsWith("/api/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, thin: true, message: "No server in the tests." }));
    return;
  }
  try {
    const file = join(root, path === "/" ? "index.html" : path);
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[file.slice(file.lastIndexOf("."))] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${site.address().port}`;

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
);
const page = await browser.newPage();
const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
await page.addInitScript(() => {
  try {
    sessionStorage.setItem("getagrip.welcomed", "yes");
    sessionStorage.setItem("getagrip.area", "money");
  } catch (err) { /* a browser refusing storage still gets the app */ }
});
await page.goto(base);
await page.waitForSelector("#money-area");

console.log("\nthe page and the server, over the same days");

for (const one of CASES) {
  const fromPage = await page.evaluate(({ rows, settings, on }) => {
    state.transactions = rows.map(normaliseTransaction).filter(Boolean);
    writeStore("remembre.moneybudgets.v1", settings.budgets);
    writeStore("remembre.incomeplan.v1", settings.income);

    const day = dayBudget(on);
    const purse = weekendPurse(new Date(`${on}T12:00:00`));
    const guard = pressureNow(on);
    return {
      weekday: day.plan.weekday,
      weekendRate: day.plan.weekend,
      base: day.base,
      carried: day.carried,
      limit: day.limit,
      spent: day.spent,
      left: day.left,
      purse: purse.purse,
      purseBase: purse.base,
      purseCarried: purse.carried,
      guardRun: guard.run,
      guardSpent: guard.spent,
      guardAllowed: guard.allowed,
      guardLevel: guard.level,
    };
  }, { rows: one.rows, settings: SETTINGS, on: one.on });

  const day = server.dayBudget(one.rows, SETTINGS, one.on);
  const purse = server.weekendPurse(one.rows, SETTINGS, one.on);
  const guard = server.pressure(one.rows, SETTINGS, one.on);
  const fromServer = {
    weekday: day.plan.weekday,
    weekendRate: day.plan.weekend,
    base: day.base,
    carried: day.carried,
    limit: day.limit,
    spent: day.spent,
    left: day.left,
    purse: purse.purse,
    purseBase: purse.base,
    purseCarried: purse.carried,
    guardRun: guard.run,
    guardSpent: guard.spent,
    guardAllowed: guard.allowed,
    guardLevel: guard.level,
  };

  check(one.name, fromPage, fromServer);
}

console.log("\nand the rules themselves");

{
  // The three shares are the whole point of the arrangement: a quarter of
  // every quiet day is what turns into savings rather than into a bigger
  // tomorrow. If they stop adding to one, the month quietly leaks.
  check("the carry adds up to exactly one",
    server.CARRY_WEEKEND + server.CARRY_TOMORROW + server.CARRY_KEPT, 1);
  check("the weekend takes the largest share",
    server.CARRY_WEEKEND > server.CARRY_TOMORROW, true);

  const pageSide = await page.evaluate(() => ({
    weekend: CARRY_WEEKEND, tomorrow: CARRY_TOMORROW, kept: CARRY_KEPT, nearly: NEARLY, ratio: WEEKEND_RATIO,
  }));
  const guardSide = await page.evaluate(() => ({
    window: GUARD_WINDOW, run: GUARD_RUN, watch: GUARD_WATCH, over: GUARD_OVER,
  }));
  check("the guard is set to the same thresholds on both sides", guardSide, {
    window: server.GUARD_WINDOW,
    run: server.GUARD_RUN,
    watch: server.GUARD_WATCH,
    over: server.GUARD_OVER,
  });

  check("and the page uses the same numbers", pageSide, {
    weekend: server.CARRY_WEEKEND,
    tomorrow: server.CARRY_TOMORROW,
    kept: server.CARRY_KEPT,
    nearly: server.NEARLY,
    ratio: server.WEEKEND_RATIO,
  });
}

{
  const loose = server.unbudgeted(CASES[6].rows, SETTINGS, "2026-10-07");
  check("spending with no budget behind it is picked out", loose.map((e) => e.category), ["clothes"]);
  check("and spending that has one is not", loose.length, 1);
}

console.log("\nthe week, looked back on");

{
  // A week that straddles two months, because October and November do not
  // have the same count of weekend days and the rates differ with it.
  const rows = [
    { id: "a", date: "2026-10-27", amount: -3000, category: "food", branch: "", deleted: false },
    { id: "b", date: "2026-10-31", amount: -9000, category: "fun", branch: "", deleted: false },
    { id: "c", date: "2026-11-01", amount: -2000, category: "food", branch: "", deleted: false },
    { id: "d", date: "2026-10-20", amount: -4000, category: "food", branch: "", deleted: false },
    { id: "e", date: "2026-10-28", amount: 60000, category: "income", branch: "", deleted: false },
    { id: "f", date: "2026-10-29", amount: -50000, category: "fun", branch: "external", deleted: false },
  ];
  const review = server.weekReview(rows, SETTINGS, "2026-11-01");

  check("the week runs Monday to Sunday", [review.monday, review.sunday], ["2026-10-26", "2026-11-01"]);
  check("and holds seven days", review.now.days.length, 7);
  check("what was spent in it", review.now.out, 14000);
  check("the week before is there to compare with", review.before.out, 4000);
  check("money in is counted", review.in, 60000);
  check("money outside the plan is not", review.now.count, 3);

  // Friday and the weekend are budgeted higher, and judged separately.
  check("weekdays and the weekend are kept apart",
    review.weekdaySpent + review.weekendSpent, review.now.out);
  check("the weekend has three days of the higher rate",
    review.now.days.filter((day) => day.weekend).length, 3);

  // Each day is rated by its own month, which is the point of the fixture.
  const october = review.now.days.find((day) => day.date === "2026-10-31");
  const november = review.now.days.find((day) => day.date === "2026-11-01");
  check("a day in the next month is rated by the next month",
    october.limit !== november.limit, true, `${october.limit} vs ${november.limit}`);

  check("a day over its limit is named", review.daysOver.includes("2026-10-31"), true);
  check("and a day inside it is not", review.daysOver.includes("2026-10-26"), false);
}

check("no page errors", problems, []);

await browser.close();
site.close();

if (failures.length) {
  console.error(`\n${failures.length} failed:\n` + failures.map((f) => `  - ${f}`).join("\n\n"));
  process.exit(1);
}
console.log(`\nbudget-test: ${passed}/${passed} checks passed`);
