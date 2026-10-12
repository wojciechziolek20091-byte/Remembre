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
  /* A wish big enough to outrun the saving the plan already does, so the
     trim is live in every case below and both sides have to agree about it. */
  wishes: "laptop = 9000 by 2026-12 from 2026-09",
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
    writeStore("remembre.wishes.v1", settings.wishes);

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
      wishAsked: wishPlan(monthOf(on)).asked,
      wishFromSaving: wishPlan(monthOf(on)).fromSaving,
      wishTaken: wishPlan(monthOf(on)).taken,
      spendable: day.plan.spendable,
    };
  }, { rows: one.rows, settings: SETTINGS, on: one.on });

  const day = server.dayBudget(one.rows, SETTINGS, one.on);
  const purse = server.weekendPurse(one.rows, SETTINGS, one.on);
  const guard = server.pressure(one.rows, SETTINGS, one.on);
  const wish = server.wishPlan(SETTINGS, one.on.slice(0, 7));
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
    wishAsked: wish.asked,
    wishFromSaving: wish.fromSaving,
    wishTaken: wish.taken,
    spendable: day.plan.spendable,
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
    /* This used to be marked as somebody else's money and left out. There is
         no such mark any more: everything that went out is spending. */
    { id: "f", date: "2026-10-29", amount: -50000, category: "fun", branch: "", deleted: false },
  ];
  const review = server.weekReview(rows, SETTINGS, "2026-11-01");

  check("the week runs Monday to Sunday", [review.monday, review.sunday], ["2026-10-26", "2026-11-01"]);
  check("and holds seven days", review.now.days.length, 7);
  check("what was spent in it", review.now.out, 64000);
  check("the week before is there to compare with", review.before.out, 4000);
  check("money in is counted", review.in, 60000);
  check("and every payment in it is counted, with no escape hatch", review.now.count, 4);

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

console.log("\nwhat the wishes take, and what pays for them");

{
  const budgets = "food = 600\nfun = 300";          // 900 a month
  const income = "1 = 2500";                        // and 1600 of surplus

  const inside = server.wishPlan({ budgets, income, wishes: "bike = 1200 by 2027-04 from 2026-10" }, "2026-10");
  check("a wish the month already saves for asks its share", inside.asked, 20000);
  check("all of it comes out of the saving", inside.fromSaving, 20000);
  check("and the spending gives up nothing", inside.taken, 0);
  check("so the daily figure does not move",
    server.weekPlan({ budgets, income, wishes: "bike = 1200 by 2027-04 from 2026-10" }, "2026-10").spendable,
    server.weekPlan({ budgets, income }, "2026-10").spendable);

  const over = { budgets, income, wishes: "laptop = 9000 by 2026-12 from 2026-10" };
  const bite = server.wishPlan(over, "2026-10");
  check("a wish beyond it asks far more", bite.asked, 450000);
  check("the saving pays what it can", bite.fromSaving, 160000);
  check("the spending gives up the rest, up to a tenth", bite.taken, 9000);
  check("which is the cap, and it says so", bite.capped, true);
  check("the month spends a tenth less", server.weekPlan(over, "2026-10").spendable, 81000);

  /* Not heavily: the whole point of the cap is that a wishlist cannot empty
     a month however much is put on it. */
  const greedy = { budgets, income, wishes: "a = 50000 by 2026-11 from 2026-10\nb = 50000 by 2026-11 from 2026-10" };
  check("two impossible wishes still only take a tenth",
    server.wishPlan(greedy, "2026-10").taken, 9000);

  const progress = server.wishPlan({ budgets, income, wishes: "bike = 1200 by 2027-04 from 2026-10" }, "2027-01").wishes[0];
  check("what has been put by is the months it has run", progress.saved, 60000);
  check("and what is left is the rest of it", progress.left, 60000);

  /* An address on the line changes nothing about what the line costs, and the
     page and the server have to agree about that as they do about the rest. */
  const linked = server.parseWishes("bike = 1200 by 2027-04 from 2026-10 at https://shop.example/done/by/2099-01/bike")[0];
  check("the server reads a link off a wish line", linked.link, "https://shop.example/done/by/2099-01/bike");
  check("without taking its path for a date", linked.by, "2027-04");
  check("or for a goal already finished", linked.done, false);
  check("and the price is untouched by it", linked.price, 120000);
  check("a link it will not use is dropped without the goal",
    server.parseWishes("bike = 1200 from 2026-10 at javascript:alert(1)")[0].price, 120000);
  check("and reads as no link", server.parseWishes("bike = 1200 from 2026-10 at javascript:alert(1)")[0].link, "");
  check("what a month gives up is the same with a link as without",
    server.wishPlan({ budgets, income, wishes: "bike = 1200 by 2027-04 from 2026-10 at https://shop.example/bike" }, "2026-10").taken,
    server.wishPlan({ budgets, income, wishes: "bike = 1200 by 2027-04 from 2026-10" }, "2026-10").taken);

  const late = server.wishPlan({ budgets, income, wishes: "late = 500 by 2026-09 from 2026-08" }, "2026-10").wishes[0];
  check("a wish whose month has gone is marked", late.overdue, true);
  check("and still asks for something rather than dividing by nothing", late.permonth, 50000);

  check("a line with no price is not a wish", server.parseWishes("nonsense").length, 0);
  check("and a comment is not either", server.parseWishes("# laptop = 4000").length, 0);
}

console.log("\nwhere the counting starts, and what has been saved");

{
  const settings = { budgets: "food = 600\nfun = 300", income: "1 = 2500" };
  const before = { id: "old", date: "2026-09-20", amount: -90000, category: "fun", deleted: false };
  const after = { id: "new", date: "2026-10-05", amount: -5000, category: "food", deleted: false };
  const gift = { id: "gift", date: "2026-10-03", amount: 30000, category: "income", branch: "", deleted: false };

  const fund = server.emergencyFund([before, after, gift], settings, "2026-10-12");
  check("the fund starts on the first of October", fund.from, "2026-10-01");
  check("and a row from before it is not in the spending", fund.spent, 5000);
  check("nor is an allowance counted for the days before", fund.allowed < 40000, true, String(fund.allowed));
  check("money in after it still counts", fund.extra, 30000);

  const saved = server.savingsSince([before, after, gift], settings, "2026-10-12");
  check("savings start there too", saved.from, "2026-10-01");
  check("and run to the day asked for", saved.to, "2026-10-12");
  check("the budget's own saving is what the plan never allocated",
    saved.surplus, Math.round((250000 - 90000) / 31 * 12));
  check("the unspent budget is what the days did not take", saved.unspent, saved.allowed - 5000);
  check("and the total is the two of them", saved.total, saved.surplus + saved.unspent);

  /* Spending more than the days allowed cannot make the unspent half
     negative: nothing was saved, which is a floor rather than a debt. */
  const heavy = server.savingsSince(
    [{ id: "lots", date: "2026-10-02", amount: -500000, category: "fun", deleted: false }],
    settings, "2026-10-12");
  check("a month that overspends saves nothing rather than minus something", heavy.unspent, 0);
  check("but the plan's own saving is still there", heavy.surplus > 0, true);

  check("asked about a day before the counting starts, it does not run backwards",
    server.savingsSince([], settings, "2026-09-01").to, "2026-09-01");
}

check("no page errors", problems, []);

await browser.close();
site.close();

if (failures.length) {
  console.error(`\n${failures.length} failed:\n` + failures.map((f) => `  - ${f}`).join("\n\n"));
  process.exit(1);
}
console.log(`\nbudget-test: ${passed}/${passed} checks passed`);
