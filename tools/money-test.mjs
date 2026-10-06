/*
  The importer, against the things that actually break importers: a preamble
  above the header, Polish number formatting, Windows-1250 bytes, the same shop
  twice in one day, and a file that is not a statement at all.

  These run in a browser because the parser uses TextDecoder and SubtleCrypto,
  both of which the real import path uses too. Nothing here touches real data.

  Run: node tools/money-test.mjs
  Set CHROMIUM_PATH if Playwright's bundled browser is not installed.
*/

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".png": "image/png", ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^(\.\.[/\\])+/, "");

  /*
    The page reads the month when the money half opens, so it calls the server
    the moment these tests get there. There is no server here: answering
    "nothing to say" is both true and quiet, and the console stays clean for
    the errors that matter.
  */
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
await new Promise((r) => server.listen(0, "127.0.0.1", r));
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
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });

/*
  The money half now opens on a dashboard, with the statement, the setup and
  the month's detail behind folds. Nothing below is about the folds, so they
  are opened on every load rather than clicked open in twelve places.
*/
await page.addInitScript(() => {
  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("details").forEach((fold) => { fold.open = true; });
  });
});
const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });

await page.goto(base);
await page.waitForSelector("#chooser");

/* ---------- Reading amounts ---------- */

console.log("\nPolish money, read as whole grosze");

{
  const amounts = await page.evaluate(() => [
    "-12,49 PLN", "1 200,00 PLN", "-1 234,56", "23.99", "0,01", "-0,05 zł",
    "1 000", "12,4", "", "abc", "5,00-",
  ].map((text) => parseAmount(text)));

  check("a card payment", amounts[0], -1249);
  check("a transfer in, with a space for thousands", amounts[1], 120000);
  check("a negative with grouping", amounts[2], -123456);
  check("a full stop as the decimal point", amounts[3], 2399);
  check("one grosz", amounts[4], 1);
  check("the złoty sign", amounts[5], -5);
  check("a round thousand is not read as a decimal", amounts[6], 100000);
  check("one digit after the comma is tens of grosze", amounts[7], 1240);
  check("nothing is nothing", amounts[8], null);
  check("and words are refused rather than guessed", amounts[9], null);
  check("a trailing minus still means out", amounts[10], -500);

  // The reason for integers in the first place.
  const drift = await page.evaluate(() =>
    [0.1, 0.2, 0.3].reduce((a, b) => a + b, 0) === 0.6);
  check("floating point would not have summed cleanly", drift, false);
}

/* ---------- Reading the file ---------- */

console.log("\nan mBank export");

{
  const rows = await page.evaluate(() => parseMbankCsv(SAMPLE_CSV));
  check("the preamble above the header is stepped over", rows.length, 6);
  check("dates come through as they are", rows[0].date, "2026-09-28");
  check("the booking date is separate", rows[0].booked, "2026-09-29");
  check("the counterparty is read", rows[0].counterparty, "ZABKA");
  check("the amount is grosze", rows[0].amount, -1249);
  check("the balance too", rows[0].balance, 184210);
  check("money in is positive", rows[2].amount, 120000);
  check("and the closing-balance footer is not a transaction",
    rows.every((r) => r.title !== ""), true);
}

{
  // The same file written the old way: Windows-1250 bytes, and the accented
  // header that goes with it.
  const rows = await page.evaluate(() => {
    const text = SAMPLE_CSV.replace("#Data ksiegowania", "#Data księgowania").replace("#Tytul", "#Tytuł");
    // Encode as windows-1250 by hand: the accented characters used here.
    const map = { "ę": 0xea, "ł": 0xb3, "ż": 0xbf, "ź": 0x9f };
    const bytes = new Uint8Array([...text].map((ch) => map[ch] ?? ch.charCodeAt(0)));
    return parseMbankCsv(decodeCsv(bytes.buffer));
  });
  check("a Windows-1250 export is decoded", rows.length, 6);
  check("with its accented column names understood", rows[0].booked, "2026-09-29");
}

{
  const refused = await page.evaluate(() => {
    try {
      parseMbankCsv("name,amount\nsomething,10");
      return "no error";
    } catch (err) {
      return err.message;
    }
  });
  check("a file that is not a statement says so plainly",
    /mBank operations export/.test(refused), true);
}

/* ---------- Importing twice ---------- */

console.log("\nimporting, and importing again");

{
  const first = await page.evaluate(async () => {
    state.transactions = [];
    return importCsvText(SAMPLE_CSV, { label: "the sample" });
  });
  check("everything lands the first time", first, { added: 6, already: 0 });

  const second = await page.evaluate(async () => importCsvText(SAMPLE_CSV, { label: "the sample" }));
  check("and nothing lands the second time", second, { added: 0, already: 6 });
  check("so the list has not doubled",
    await page.evaluate(() => liveTransactions().length), 6);

  // The one a content hash alone gets wrong.
  const twice = await page.evaluate(() =>
    liveTransactions().filter((t) => t.counterparty === "ZABKA").length);
  check("two identical purchases on one day are two transactions", twice, 2);

  // An overlapping export: some rows seen before, some new.
  const overlap = await page.evaluate(async () => {
    const lines = SAMPLE_CSV.split("\r\n");
    const header = lines.slice(0, 4);
    const kept = lines.slice(4, 7);
    const extra = "2026-09-30;2026-09-30;PLATNOSC KARTA;ORLEN 1234;ORLEN;;-45,00 PLN;1 797,10 PLN";
    return importCsvText([...header, extra, ...kept].join("\r\n"), { label: "an overlap" });
  });
  check("an overlapping export adds only what is new", overlap, { added: 1, already: 3 });
  check("leaving seven in total",
    await page.evaluate(() => liveTransactions().length), 7);
}

{
  // Ids have to be stable across devices, or sync would duplicate everything.
  const stable = await page.evaluate(async () => {
    const rows = parseMbankCsv(SAMPLE_CSV);
    const a = await identify(rows);
    const b = await identify(rows);
    return a.map((r) => r.id).join() === b.map((r) => r.id).join();
  });
  check("the same rows always get the same ids", stable, true);
}

/* ---------- Deciding what each one was for ---------- */

console.log("\ncategorising");

{
  const folded = await page.evaluate(() => [
    fold("\u017bABKA"), fold("Ksi\u0119garnia"), fold("\u0141\u00d3D\u017a"), fold("Biedronka"),
  ]);
  check("accents and case are folded away", folded, ["zabka", "ksiegarnia", "lodz", "biedronka"]);

  const rules = await page.evaluate(() => parseRules([
    "# a comment",
    "",
    "food = zabka, biedronka",
    "not a rule at all",
    "transport = mpk",
  ].join("\n")));
  check("comments and nonsense lines are skipped", rules.length, 2);
  check("the patterns come through folded", rules[0], { category: "food", patterns: ["zabka", "biedronka"] });
}

{
  const got = await page.evaluate(() => {
    const rules = parseRules(DEFAULT_RULES);
    const of = (counterparty, title, amount) =>
      categorise({ counterparty, title, description: "", amount }, rules);
    return {
      zabka: of("\u017bABKA", "ZABKA Z7423 KRAKOW", -1249),
      spotify: of("SPOTIFY AB", "SPOTIFY P0A1B2C3", -2399),
      mpk: of("MPK", "BILET MPK KRAKOW", -400),
      pocket: of("JAN ZIOLEK", "Kieszonkowe", 120000),
      mystery: of("SOMETHING ODD", "", -5000),
      // Money in with no rule is income, not "other": a positive amount is
      // already a strong signal and leaving it loose makes totals read wrong.
      refund: of("SOMETHING ODD", "", 5000),
    };
  });

  check("a corner shop is food", got.zabka, "food");
  check("a streaming charge is a subscription", got.spotify, "subscriptions");
  check("a tram ticket is transport", got.mpk, "transport");
  check("pocket money is income", got.pocket, "income");
  check("something with no rule is left loose", got.mystery, "other");
  check("but money in with no rule is income", got.refund, "income");
}

{
  // Order is the only precedence there is, which is what makes a wrong
  // category fixable by moving a line.
  const order = await page.evaluate(() => {
    const first = parseRules("fun = kino\nschool = kino ksiegarnia");
    const second = parseRules("school = kino ksiegarnia\nfun = kino");
    const row = { counterparty: "KINO KSIEGARNIA", title: "", description: "", amount: -2000 };
    return [categorise(row, first), categorise(row, second)];
  });
  check("the first matching line wins", order, ["fun", "school"]);
}

{
  const applied = await page.evaluate(async () => {
    state.transactions = [];
    writeStore("remembre.moneyrules.v1", DEFAULT_RULES);
    await importCsvText(SAMPLE_CSV, { label: "the sample" });
    return liveTransactions().map((t) => `${t.counterparty}:${t.category}`).sort();
  });
  check("importing categorises as it goes", applied, [
    "JERONIMO MARTINS:food", "JAN ZIOLEK:income", "MPK:transport",
    "SPOTIFY AB:subscriptions", "ZABKA:food", "ZABKA:food",
  ].sort());

  const retuned = await page.evaluate(() => {
    writeStore("remembre.moneyrules.v1", "fun = spotify");
    return { changed: recategorise(), spotify: liveTransactions().find((t) => t.counterparty === "SPOTIFY AB").category };
  });
  check("editing the rules moves what they match", retuned.spotify, "fun");
  check("and reports how many moved", retuned.changed > 0, true);

  const tally = await page.evaluate(() => {
    writeStore("remembre.moneyrules.v1", DEFAULT_RULES);
    recategorise();
    return categoryTally().map((row) => [row.category, row.count]);
  });
  check("the tally groups them, biggest spend first", tally[0], ["food", 3]);
  check("and counts every transaction once",
    tally.reduce((sum, [, count]) => sum + count, 0), 6);
}

{
  // The editor is the config file, so what it holds has to survive a save.
  // It lives in the money half, which has to be open to be typed into.
  await page.click('[data-area="money"]');
  await page.evaluate(() => { writeStore("remembre.moneyrules.v1", DEFAULT_RULES); renderRules(); });
  await page.fill("#money-rules", "fun = zabka");
  await page.click("#money-rules-save");
  check("saving the editor applies what is in it",
    await page.evaluate(() => liveTransactions().find((t) => t.counterparty === "ZABKA").category), "fun");
  check("and the row says so",
    (await page.locator(".tx .tx-cat").first().innerText()).trim().length > 0, true);

  page.once("dialog", (d) => d.accept());
  await page.click("#money-rules-reset");
  check("restoring the defaults puts them back",
    await page.evaluate(() => liveTransactions().find((t) => t.counterparty === "ZABKA").category), "food");
  check("and refills the editor",
    (await page.inputValue("#money-rules")).includes("biedronka"), true);
}

/* ---------- The month ---------- */

console.log("\nthe month's report");

/* Two months of invented statement, so there is something to compare against. */
const TWO_MONTHS = [
  "#Numer rachunku;",
  "PL61109010140000071219812874;",
  "",
  "#Data operacji;#Data ksiegowania;#Opis operacji;#Tytul;#Nadawca/Odbiorca;#Numer konta;#Kwota;#Saldo po operacji",
  "2026-08-04;2026-08-05;PLATNOSC KARTA;SPOTIFY P0A1B2C3;SPOTIFY AB;;-23,99 PLN;900,00 PLN",
  "2026-08-09;2026-08-10;PLATNOSC KARTA;BIEDRONKA 4471;JERONIMO MARTINS;;-120,00 PLN;780,00 PLN",
  "2026-08-20;2026-08-21;PLATNOSC KARTA;BILET MPK KRAKOW;MPK;;-40,00 PLN;740,00 PLN",
  "2026-09-03;2026-09-04;PLATNOSC KARTA;SPOTIFY P0A1B2C3;SPOTIFY AB;;-23,99 PLN;716,01 PLN",
  "2026-09-07;2026-09-08;PLATNOSC KARTA;BIEDRONKA 4471;JERONIMO MARTINS;;-500,00 PLN;216,01 PLN",
  "2026-09-11;2026-09-12;PLATNOSC KARTA;ZABKA Z1;ZABKA;;-80,00 PLN;136,01 PLN",
  "2026-09-15;2026-09-16;PRZELEW PRZYCHODZACY;Kieszonkowe;JAN ZIOLEK;;1 000,00 PLN;1 136,01 PLN",
  "2026-09-18;2026-09-19;PLATNOSC KARTA;BILET MPK KRAKOW;MPK;;-30,00 PLN;1 106,01 PLN",
].join("\r\n");

{
  const report = await page.evaluate(async (csv) => {
    state.transactions = [];
    writeStore("remembre.moneyrules.v1", DEFAULT_RULES);
    writeStore("remembre.moneybudgets.v1", "food = 400\ntransport = 100");
    // No schedule here: this section is about the month's own arithmetic, and
    // with a plan set the 1 000 that lands on the 15th is external money and
    // would rightly be left out of it.
    writeStore("remembre.incomeplan.v1", "# none");
    await importCsvText(csv, { label: "two months" });
    const september = monthReport("2026-09");
    const august = monthReport("2026-08");
    return {
      opensOn: state.moneyMonth,
      septemberSpent: september.spent,
      septemberIn: september.received,
      augustSpent: august.spent,
      food: september.byCategory.get("food"),
      transport: september.byCategory.get("transport"),
      biggest: september.biggest.map((e) => e.amount),
      change: describeChange(september.spent, august.spent, "2026-08"),
    };
  }, TWO_MONTHS);

  check("it opens on the month the data ends in", report.opensOn, "2026-09");
  check("September's spending is totalled", report.septemberSpent, -63399);
  check("money in is counted apart from it", report.septemberIn, 100000);
  check("so a transfer in cannot look like frugal living",
    report.septemberSpent < 0 && report.septemberIn > 0, true);
  check("August is there to compare with", report.augustSpent, -18399);
  check("food adds up across the month", report.food, -58000);
  check("and transport too", report.transport, -3000);
  check("the biggest come first", report.biggest[0], -50000);
  check("and there are at most five", report.biggest.length <= 5, true);
  check("the comparison is said in words, not just a number",
    report.change, "450,00 z\u0142 more than August");
}

{
  const months = await page.evaluate(() => {
    const seen = [];
    state.moneyMonth = "2026-09";
    seen.push(state.moneyMonth);
    state.moneyMonth = shiftMonth(state.moneyMonth, -1);
    seen.push(state.moneyMonth);
    // Over a year boundary, where a naive month subtraction goes wrong.
    seen.push(shiftMonth("2026-01", -1), shiftMonth("2026-12", 1));
    return seen;
  });
  check("stepping back a month works", months.slice(0, 2), ["2026-09", "2026-08"]);
  check("and over a year boundary in both directions",
    months.slice(2), ["2025-12", "2027-01"]);
}

{
  const budgets = await page.evaluate(() => {
    const parsed = parseBudgets("# comment\nfood = 400\ntransport = 100\nnonsense\nfun = 0\n");
    return [...parsed.entries()];
  });
  check("budgets are read in grosze", budgets, [["food", 40000], ["transport", 10000]]);
  check("and a zero limit is not a budget", budgets.some(([name]) => name === "fun"), false);
}

{
  // Idempotent: an earlier block may already have opened this half, and then
  // the tile that opens it is not on screen to click.
  await page.evaluate(() => { setArea("money"); state.moneyMonth = "2026-09"; renderReport(); });

  check("the month is named", (await page.textContent("#money-month")).trim(), "September 2026");
  // innerText gives what is rendered, and the stylesheet capitalises it; the
  // category itself is lower case.
  check("a category over its limit is marked",
    (await page.locator(".report-row.is-over .report-name").first().innerText()).toLowerCase(), "food");
  check("and says by how much",
    (await page.locator(".report-row.is-over .report-limit").first().innerText()).includes("over"), true);

  // Colour is never the only signal, so the words have to carry it too.
  const underText = await page.locator(".report-row").filter({ hasText: "transport" }).first().innerText();
  check("one still inside its limit says what is left", underText.includes("left of"), true);

  check("the recurring charges are picked out",
    (await page.locator(".report-sub").allInnerTexts()).some((t) => t.includes("every month")), true);
  const repeats = await page.evaluate(() => recurringCharges().map((c) => [c.name, c.typical, c.months]));
  check("a subscription seen in two months is recurring",
    repeats.find((r) => r[0] === "SPOTIFY AB"), ["SPOTIFY AB", 2399, 2]);
  check("but a shop whose amount swings wildly is not",
    repeats.some((r) => r[0] === "JERONIMO MARTINS"), false);
  check("and something seen once is not either",
    repeats.some((r) => r[0] === "ZABKA"), false);

  await page.click("#money-prev");
  check("stepping back shows August", (await page.textContent("#money-month")).trim(), "August 2026");
  await page.click("#money-next");
  await page.click("#money-next");
  check("and forward lands on an empty month, saying so",
    (await page.textContent("#money-report")).includes("Nothing in this month"), true);
  await page.evaluate(() => { state.moneyMonth = "2026-09"; renderReport(); });
}

{
  // Pasting takes the same path as the file picker, which is the point.
  const pasted = await page.evaluate(async () => {
    state.transactions = [];
    renderMoney();
    return importCsvText(SAMPLE_CSV, { label: "what you pasted" });
  });
  check("pasted text imports like a file", pasted, { added: 6, already: 0 });

  await page.click("#money-paste-open");
  check("the paste box opens", await page.locator("#money-paste").isVisible(), true);
  await page.fill("#money-paste-text", "not a statement");
  await page.click("#money-paste-import");
  check("and nonsense in it is refused by name",
    (await page.textContent("#money-status")).includes("mBank operations export"), true);
}

/* ---------- On the page ---------- */

console.log("\nthe two halves");

{
  check("the calendar half stays out of the way",
    await page.locator("#school-area").isVisible(), false);

  check("money is open", await page.locator("#money-area").isVisible(), true);
  check("and the whole page takes its surface, bar and footer included",
    await page.evaluate(() => document.body.classList.contains("on-money")), true);
  check("and the calendar's controls step aside",
    await page.locator("#add-task-top").isVisible(), false);
  // Scoped to the list itself: the same row is used in the category folds and
  // in the biggest-of-the-month list now.
  check("the transactions are listed",
    await page.locator("#money-list .tx").count(), 6);
  check("the newest first",
    (await page.locator("#money-list .tx .tx-date").first().innerText()).trim(), "09-28");
  check("with amounts in złoty",
    (await page.locator("#money-list .tx .tx-amount").first().innerText()).includes("12,49"), true);
  // A column of figures that sometimes groups and sometimes does not is worse
  // than one that never does, so the grouping is ours rather than the browser's.
  check("and thousands grouped the Polish way",
    await page.evaluate(() => [zloty(120000), zloty(-1234567), zloty(5)]),
    ["1\u00a0200,00 z\u0142", "\u221212\u00a0345,67 z\u0142", "0,05 z\u0142"]);

  await page.click("#area-back");
  check("switching goes back to the choice", await page.locator("#chooser").isVisible(), true);

  await page.click('[data-area="school"]');
  check("and schoolwork still opens", await page.locator("#school-area").isVisible(), true);
  check("with the paper surface back",
    await page.evaluate(() => document.body.classList.contains("on-money")), false);
  check("with its controls back", await page.locator("#add-task-top").isVisible(), true);
  check("and the timetable drawn", await page.locator(".tt-lesson").count() > 0, true);
}

/* ---------- The dashboard ---------- */

/*
  The dashboard answers three questions in order -- what have I got, where did
  it go, how fast is it going -- so each is checked against a statement built
  to a known shape. The dates are relative to today, because a fixture with
  2026-09 in it stops testing the thing the day the month turns.
*/

console.log("\nthe dashboard");

/**
 * A statement spending `perDay` zloty every day for `days` days up to
 * yesterday, with one payment in, and a footer closing balance.
 */
function statement({ days = 21, perDay = 20, income = 1000, closing = 1000 } = {}) {
  const day = (back) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - back);
    return date.toISOString().slice(0, 10);
  };

  const rows = [];
  for (let back = days; back >= 1; back -= 1) {
    rows.push(`${day(back)};${day(back)};PLATNOSC KARTA;ZABKA Z1;ZABKA;;-${perDay},00 PLN;0,00 PLN`);
    if (back % 7 === 0) {
      rows.push(`${day(back)};${day(back)};PLATNOSC KARTA;BILET MPK KRAKOW;MPK;;-4,00 PLN;0,00 PLN`);
    }
  }
  rows.push(`${day(days)};${day(days)};PRZELEW PRZYCHODZACY;Kieszonkowe;JAN ZIOLEK;;${income},00 PLN;0,00 PLN`);

  return [
    "#Numer rachunku;",
    "PL61109010140000071219812874;",
    "",
    "#Data operacji;#Data ksiegowania;#Opis operacji;#Tytul;#Nadawca/Odbiorca;#Numer konta;#Kwota;#Saldo po operacji",
    ...rows,
    "",
    `#Saldo koncowe;;;;;;${closing},00 PLN;`,
  ].join("\r\n");
}

{
  await page.evaluate(() => { setArea("money"); });

  const read = await page.evaluate(async (csv) => {
    localStorage.removeItem("remembre.balance.v1");
    localStorage.removeItem("remembre.balanceseen.v1");
    localStorage.removeItem("remembre.insight.v1");
    localStorage.removeItem("remembre.plan.v1");
    state.transactions = [];
    writeStore("remembre.moneyrules.v1", DEFAULT_RULES);
    writeStore("remembre.moneybudgets.v1", "food = 400\ntransport = 100");
    await importCsvText(csv, { label: "a statement" });
    return {
      balance: balanceNow(),
      stored: readStore("remembre.balance.v1", null),
      figure: document.querySelector(".kpi-figure").textContent,
      note: document.querySelector("#money-balance .kpi-note").textContent,
    };
  }, statement({ closing: 1000 }));

  // The footer figure is the account's own, and the sum of the rows is not it.
  check("the statement's closing balance is taken from its footer", read.stored.amount, 100000);
  check("and shown as the first thing on the page", read.figure.includes("1 000,00"), true);
  check("with where it came from beside it", /statement that closed on/.test(read.note), true);
  check("rather than a sum of what was imported", read.balance.amount, 100000);
  check("and nothing is pending at that point", read.balance.since, 0);
}

{
  // A card payment that arrived after the statement was cut still counts.
  const rolled = await page.evaluate(() => {
    const after = new Date();
    after.setUTCDate(after.getUTCDate() + 1);
    const date = after.toISOString().slice(0, 10);
    state.transactions.push(normaliseTransaction({
      id: "later-one", date, amount: -5000, counterparty: "ZABKA", category: "food",
    }));
    renderBalanceCard();
    return { balance: balanceNow(), note: document.querySelector("#money-balance .kpi-note").textContent };
  });

  check("a transaction newer than the statement is rolled forward", rolled.balance.amount, 95000);
  check("and the card says how many and how much", /1 transaction since \(−50,00/.test(rolled.note), true);

  const moved = await page.evaluate(() => {
    renderBalanceCard();
    const first = document.querySelector(".kpi-move");
    state.transactions = state.transactions.filter((t) => t.id !== "later-one");
    renderBalanceCard();
    return { first: Boolean(first), second: document.querySelector(".kpi-move").textContent };
  });
  check("a balance that has not moved says nothing about movement", moved.first, false);
  check("one that has is compared with what you last saw",
    /↑ 50,00 zł since you last looked/.test(moved.second), true);
}

{
  // The bank knows better than any statement, so it wins when it is there.
  const fromBank = await page.evaluate(() => {
    renderBank({ connected: true, accounts: [{ name: "eKonto", iban: "…8067" }],
      balance: { amount: 123456, at: "2026-10-01", readAt: new Date().toISOString(), type: "ITAV" } });
    renderBalanceCard();
    return { balance: balanceNow(), note: document.querySelector("#money-balance .kpi-note").textContent };
  });
  check("the bank's own figure wins over a statement's", fromBank.balance.amount, 123456);
  check("and says so", /Straight from mBank/.test(fromBank.note), true);
  await page.evaluate(() => { bankBalance = null; renderBalanceCard(); });
}

{
  const shown = await page.evaluate(() => {
    /*
      The month holding most of the fixture, which is not always the one it
      ends in: the statement runs back three weeks from yesterday, so on the
      2nd of a month "the month the data ends in" is a single day of it. The
      app's own default is still latestMonth(); this is the test choosing
      which month it means.
    */
    const monthKey = monthOf(shiftISO(todayISO(), -14));
    state.moneyMonth = monthKey;
    /*
      And a limit the fixture is certainly past, worked out from the fixture
      rather than written in. How much of a three-week statement lands in that
      month depends on where in the calendar today is, so a fixed 400 was a
      budget the data went past in some weeks of the year and not in others.
    */
    const food = Math.abs(transactionsIn("food", monthKey)
      .reduce((sum, entry) => sum + entry.amount, 0));
    const limit = Math.floor(food / 100) - 50;
    writeStore("remembre.moneybudgets.v1", `food = ${limit}\ntransport = 100`);
    renderCategoryBars();
    const rows = [...document.querySelectorAll(".bar-row")].map((row) => ({
      name: row.querySelector(".bar-name").textContent,
      value: row.querySelector(".bar-value").textContent,
      width: row.querySelector(".bar-fill").style.width,
      step: [...row.querySelector(".bar-fill").classList].find((c) => c.startsWith("seq-")),
      note: row.querySelector(".bar-note").textContent,
    }));
    return { rows, limit };
  });

  const bars = shown.rows;
  check("the categories are a chart, biggest first", bars[0].name, "food");
  check("the biggest bar is full width", bars[0].width, "100%");
  check("and the darkest step of the one hue", bars[0].step, "seq-5");
  check("a smaller one gets a lighter step", bars[1].step !== "seq-5", true);
  check("every bar carries its own figure, so the colour is decoration",
    bars.every((bar) => /\d,\d\d zł$/.test(bar.value)), true);
  check("and its share of the month", /% of the month/.test(bars[0].note), true);
  check("a budget it has gone past is said in words",
    new RegExp(`over the ${shown.limit},00 zł limit`).test(bars[0].note), true,
    bars[0].note);

  // Tapping a bar is how you find out which single payment it was.
  await page.click(".bar-row:first-child .bar-open");
  check("opening a category shows the payments in it",
    await page.locator(".bar-row:first-child .tx").count() > 0, true);
  check("biggest first, because that is the one worth moving",
    (await page.locator(".bar-row:first-child .tx-title").first().innerText()).trim(), "ZABKA");
  check("and each one opens", 
    await page.locator(".bar-row:first-child .tx-open").first().isEnabled(), true);
}

{
  // Money moved to your own account has not been spent, so it is not spending.
  const withTransfer = await page.evaluate(async () => {
    state.transactions.push(normaliseTransaction({
      id: "own-transfer", date: todayISO(), amount: -30000,
      counterparty: "WLASNY", title: "PRZELEW WLASNY", category: "transfers",
    }));
    renderCategoryBars();
    const names = [...document.querySelectorAll(".bar-name")].map((n) => n.textContent);
    const rate = sustainability();
    state.transactions = state.transactions.filter((t) => t.id !== "own-transfer");
    return { names, perDay: rate.perDay };
  });
  check("a transfer to yourself is not in the categories",
    withTransfer.names.includes("transfers"), false);
  check("nor in the daily rate", withTransfer.perDay < 10000, true);
}

{
  const rate = await page.evaluate(() => {
    renderRateCard();
    const read = sustainability();
    return {
      verdict: read.verdict,
      perDay: read.perDay,
      columns: document.querySelectorAll(".rate-col").length,
      weeks: document.querySelectorAll(".week").length,
      mark: document.querySelector(".verdict-mark").textContent,
      label: document.querySelector(".verdict-label").textContent,
      why: document.querySelector(".verdict-why").textContent,
      line: Boolean(document.querySelector(".rate-line")),
      lineLabel: (document.querySelector(".rate-key") || {}).textContent,
      table: document.querySelectorAll("#money-rate .as-table .plain-table tbody tr").length,
    };
  });

  // The statement is three weeks old, so the window is three weeks and a day,
  // not four weeks with a week of invented zeros at the front.
  check("the chart covers the days there is data for", rate.columns, 22);
  check("with the complete weeks summarised under it", rate.weeks, 3);
  check("the rate is what was spent over those days",
    rate.perDay > 1900 && rate.perDay < 2050, true, String(rate.perDay));
  // 20 zl a day is about 630 zl a month against 1 000 zl coming in.
  check("spending well inside what comes in is sustainable", rate.verdict, "sustainable");
  check("and the word is on the page, not just a colour", rate.label, "Sustainable");
  check("with a mark beside it", rate.mark.length > 0, true);
  check("and the arithmetic spelled out", /a day this month would cost/.test(rate.why), true);
  check("there is a line to read the columns against", rate.line, true);
  check("and a key under the chart says what it is",
    /dashed line is .* a day, which keeps the month even/.test(rate.lineLabel), true);
  check("the same numbers are available as a table", rate.table, 3);
}

{
  // The same days, five times the spending: 100 zl a day against 1 000 zl in.
  const fast = await page.evaluate(async (csv) => {
    state.transactions = [];
    await importCsvText(csv, { label: "a fast month" });
    renderRateCard();
    return {
      verdict: sustainability().verdict,
      label: document.querySelector(".verdict-label").textContent,
      why: document.querySelector(".verdict-why").textContent,
    };
  }, statement({ perDay: 100, income: 1000 }));
  check("spending faster than it comes in is called that", fast.verdict, "overspending");
  check("in words", /faster than it comes/.test(fast.label), true);
  check("with the shortfall in zloty", /more than comes in/.test(fast.why), true);

  // With a plan set, the plan is the measure whatever happens to arrive. With
  // no plan and nothing coming in, there is nothing to measure against and
  // saying so is the only honest answer.
  const noIncome = await page.evaluate(async (csv) => {
    state.transactions = [];
    writeStore("remembre.incomeplan.v1", "# none");
    await importCsvText(csv, { label: "no income" });
    const read = sustainability();
    writeStore("remembre.incomeplan.v1", DEFAULT_INCOME_PLAN);
    return { verdict: read.verdict, why: read.why };
  }, statement({ perDay: 20, income: 0 }).replace(/.*PRZELEW PRZYCHODZACY.*\r\n/, ""));
  check("with no plan and nothing coming in, no verdict is invented", noIncome.verdict, "unclear");
  check("and it says what is missing", /no income plan is set/i.test(noIncome.why), true, noIncome.why);

  // The plan carries the month even before the instalments land.
  const onPlan = await page.evaluate(async (csv) => {
    state.transactions = [];
    await importCsvText(csv, { label: "plan only" });
    const read = sustainability();
    return { verdict: read.verdict, typical: read.typical };
  }, statement({ perDay: 20, income: 0 }).replace(/.*PRZELEW PRZYCHODZACY.*\r\n/, ""));
  check("with a plan, the month is measured even before money lands", onPlan.typical, 250000);
  check("and 20 zloty a day fits inside 2 500", onPlan.verdict, "sustainable");
}

/* ---------- The income plan ---------- */

/*
  2 500 a month in four instalments, and anything off that schedule is a
  question rather than an assumption. The dates are built relative to the
  month being tested, so none of this goes stale.
*/

console.log("\nthe income plan");

{
  const read = await page.evaluate(() => {
    const plan = parseIncomePlan("1 = 700\n8 = 600\n15 = 600\n22 = 600\n# a comment\nnonsense\n0 = 50\n");
    return { plan, total: plan.reduce((sum, slot) => sum + slot.amount, 0) };
  });
  check("the schedule is read", read.plan.map((s) => [s.day, s.amount]),
    [[1, 70000], [8, 60000], [15, 60000], [22, 60000]]);
  check("and comes to the right month", read.total, 250000);
  check("a day that is not a day is dropped", read.plan.length, 4);
}

{
  // A month of the plan, one instalment two days late, and one wire that is
  // not on the schedule at all.
  const month = "2026-09";
  const rows = await page.evaluate(async (key) => {
    state.transactions = [];
    writeStore("remembre.incomeplan.v1", "1 = 700\n8 = 600\n15 = 600\n22 = 600\n");
    const add = (date, amount, who) => state.transactions.push(normaliseTransaction({
      id: `${date}-${amount}`, date, amount, counterparty: who, category: amount > 0 ? "income" : "food",
    }));
    state.moneyMonth = key;
    add(`${key}-01`, 70000, "MAMA");
    add(`${key}-10`, 60000, "MAMA");          // two days late
    add(`${key}-15`, 60000, "MAMA");
    add(`${key}-11`, 50000, "BABCIA");        // not on the schedule
    saveTransactions();
    classifyIncome();
    const standing = incomeStanding(key);
    return {
      branches: liveTransactions().filter((e) => e.amount > 0)
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((e) => [e.date.slice(8), e.amount, e.branch]),
      planned: standing.planned,
      arrived: standing.arrived,
      toCome: standing.toCome,
      next: standing.next ? standing.next.day : null,
      external: liveTransactions().filter((e) => e.amount > 0 && e.branch === "external").length,
    };
  }, month);

  check("a payment on its day is counted as the plan", rows.branches[0], ["01", 70000, "plan"]);
  check("and one a couple of days late still is", rows.branches.find((r) => r[0] === "10"), ["10", 60000, "plan"]);
  // Nothing is asked about what already happened: off the schedule is
  // external, and that is the whole of the decision.
  check("one that is not on the schedule is external, without a question",
    rows.branches.find((r) => r[0] === "11"), ["11", 50000, "external"]);
  check("the month is measured against the plan, not against what landed", rows.planned, 250000);
  check("what has arrived is what matched it", rows.arrived, 190000);
  check("the rest is still to come", rows.toCome, 60000);
  check("and it says which instalment is next", rows.next, 22);
  check("and it is counted apart from the plan", rows.external, 1);
  // With no schedule there is nothing to be outside of, and calling every
  // payment external would empty the month of its income.
  check("but with no schedule set, nothing is external",
    await page.evaluate(() => {
      const before = readStore("remembre.incomeplan.v1", null);
      writeStore("remembre.incomeplan.v1", "# none");
      state.transactions.forEach((entry) => { if (entry.amount > 0) entry.branch = ""; });
      classifyIncome();
      const any = liveTransactions().filter((e) => e.branch === "external").length;
      writeStore("remembre.incomeplan.v1", before);
      state.transactions.forEach((entry) => { if (entry.amount > 0) entry.branch = ""; });
      classifyIncome();
      return any;
    }), 0);
}

{
  const card = await page.evaluate(() => {
    renderDashboard();
    return {
      plan: (document.querySelector(".kpi-plan") || {}).textContent || "",
      outside: (document.querySelector(".outside-row") || {}).textContent || "",
      asked: document.querySelectorAll(".review-row").length,
    };
  });
  check("the card leads with the plan",
    /Plan 2\u00a0500,00 z\u0142, 1\u00a0900,00 z\u0142 in, 600,00 z\u0142 to come · next 600,00 z\u0142 on the 22nd/.test(card.plan),
    true, card.plan);
  check("what came from outside it is listed apart", /BABCIA/.test(card.outside), true, card.outside);
  check("and nothing on the page asks about it", card.asked, 0);
}

{
  // And whatever the money paid for is linked to it, also without asking.
  const linked = await page.evaluate(() => {
    state.transactions.push(normaliseTransaction({
      id: "the-ticket", date: "2026-09-13", amount: -50000, counterparty: "EBILET", category: "fun",
    }));
    saveTransactions();
    classifyIncome();
    renderDashboard();
    const ticket = liveTransactions().find((e) => e.id === "the-ticket");
    return {
      branch: ticket.branch,
      linkedTo: Boolean(ticket.linkedTo),
      counted: liveTransactions().filter(SPENT_OUT).length,
      row: (document.querySelector(".outside-paid") || {}).textContent || "",
    };
  });
  check("the spending it paid for is linked to it", linked.branch, "external");
  check("and remembers which payment it belonged to", linked.linkedTo, true);
  check("neither side is counted as the month's spending", linked.counted, 0);
  check("and the card says what it paid for", /paid for EBILET/.test(linked.row), true, linked.row);

  // When the guess is wrong, putting it back is an action rather than a
  // question, and it stays put.
  const back = await page.evaluate(() => {
    countItAgain("the-ticket");
    classifyIncome();
    const ticket = liveTransactions().find((e) => e.id === "the-ticket");
    return { branch: ticket.branch, counted: ticket.counted, spending: liveTransactions().filter(SPENT_OUT).length };
  });
  check("putting it back counts it again", back.branch, "");
  check("and the linker does not take it away a second time", back.counted, true);
  check("so it is the month's spending now", back.spending, 1);
}

{
  // The whole point of the branch: it must not move the verdict.
  const kept = await page.evaluate(() => {
    const before = sustainability();
    state.transactions.push(normaliseTransaction({
      id: "outside-spend", date: "2026-09-14", amount: -120000,
      counterparty: "SOMETHING BIG", category: "other", branch: "external",
    }));
    saveTransactions();
    const after = sustainability();
    return { before: before.perDay, after: after.perDay, typical: after.typical };
  });
  check("external spending does not touch the rate", kept.after, kept.before);
  check("and the plan is what the rate is measured against", kept.typical, 250000);
}

{
  // What the analysis is given: this month in detail, the ones before it in
  // two numbers each.
  const digest = await page.evaluate(() => {
    state.transactions.push(normaliseTransaction({
      id: "august-one", date: "2026-08-12", amount: -20000, counterparty: "ZABKA", category: "food",
    }));
    saveTransactions();
    state.moneyMonth = "2026-09";
    return buildDigest();
  });
  check("the plan is in the summary", digest.income.planPerMonth, 2500);
  check("with what has arrived of it", digest.income.arrivedThisMonth, 1900);
  check("and the schedule itself", digest.income.schedule.length, 4);
  check("the external branch is named, apart", digest.external.inThisMonth, 500);
  check("so the model cannot read it as overspending",
    /never as overspending/.test(digest.external.note), true);
  check("earlier months are two numbers each",
    Object.keys(digest.earlierMonths[0]).sort(), ["in", "month", "out"]);
  check("and are not broken down by category",
    digest.categories.every((row) => !("august" in row)), true);
}

/* ---------- Coming back from the bank ---------- */

/*
  Every one of these used to be silent. The page looked identical whether the
  approval had worked or not, because the only thing that said otherwise went
  to a region screen readers read and to a panel behind a fold.
*/

console.log("\nwhat the bank's answer looks like");

{
  const states = await page.evaluate(() => {
    const read = () => ({
      hidden: document.querySelector("#money-notice").hidden,
      text: (document.querySelector(".notice-text") || {}).textContent || "",
      tone: document.querySelector("#money-notice").className,
      line: (document.querySelector(".kpi-bank") || {}).textContent || "",
      dot: [...(document.querySelector(".kpi-dot") || { classList: [] }).classList].join(" "),
    });

    const out = {};

    // Without a sync phrase the server cannot be told whose account it is, so
    // that is the first thing the line has to say.
    bankConnection = null;
    renderBalanceCard();
    out.noPhrase = read();

    // From here on, as it looks once syncing is on. Put back at the end of
    // the section: left in place it would make every later setArea("money")
    // call the server, which is not running here.
    window.__realBankPhrase = bankPhrase;
    bankPhrase = () => "a phrase";
    renderBalanceCard();
    out.notConnected = read();

    renderBank({
      connected: true, expired: false, fetchedTo: todayISO(),
      accounts: [{ name: "eKonto", iban: "…8067" }],
    });
    out.connected = read();

    renderBank({
      connected: true, expired: true, fetchedTo: "",
      accounts: [{ name: "eKonto", iban: "…8067" }],
    });
    out.expired = read();

    showMoneyNotice(outcomeText("no-accounts").text, { tone: "warn" });
    out.noAccounts = read();

    showMoneyNotice("");
    out.dismissed = read();
    return out;
  });

  // "Not connected" and "connected and quiet" are the one pair that has to be
  // told apart when nothing is arriving.
  check("with syncing off, it says that is what is in the way",
    /once syncing is on/.test(states.noPhrase.line), true, states.noPhrase.line);
  // Being told what is in the way without being told where is half an answer.
  check("and offers to take you to it", /Turn syncing on/.test(states.noPhrase.line), true);
  check("the dashboard says when the bank is not connected",
    /not connected/.test(states.notConnected.line), true, states.notConnected.line);
  check("and offers to connect it there", /Connect it/.test(states.notConnected.line), true);
  check("it says when it is connected, and to what",
    /connected. eKonto …8067/.test(states.connected.line), true, states.connected.line);
  check("and when it was last checked", /last checked/.test(states.connected.line), true);
  check("a consent that has run out says so in words",
    /wants approving again/.test(states.expired.line), true, states.expired.line);
  // Colour is never the only signal: each dot has a sentence beside it.
  check("the dot is never the only thing saying which",
    [states.notConnected.dot, states.connected.dot, states.expired.dot],
    ["kpi-dot is-off", "kpi-dot is-on", "kpi-dot is-stale"]);

  check("an outcome from the bank is shown, not only announced",
    states.noAccounts.hidden, false);
  check("and says what to do about it",
    /ticked before you confirm/.test(states.noAccounts.text), true, states.noAccounts.text);
  check("the notice can be put away", states.dismissed.hidden, true);
}

{
  // The route from "syncing is what is in the way" to the box you type it in.
  await page.evaluate(() => { bankPhrase = window.__realBankPhrase; });
  const went = await page.evaluate(() => {
    setArea("money");
    const fold = document.getElementById("settings-fold");
    if (fold) fold.open = false;
    openSyncing();
    return {
      area: state.area,
      panel: Boolean(document.querySelector("#cloud-panel")),
      opened: document.getElementById("settings-fold").open,
      focused: document.activeElement.id,
    };
  });
  check("tapping it opens the half syncing lives in", went.area, "school");
  check("where the panel is", went.panel, true);
  // Being sent to a panel inside a shut fold is being sent nowhere.
  check("and the fold it is folded into", went.opened, true);
  check("with the cursor already in the phrase box", went.focused, "cloud-code");
  await page.evaluate(() => setArea("money"));
}

{
  // The explanation outlives the redirect it arrived on.
  const kept = await page.evaluate(() => {
    showMoneyNotice("something happened", { tone: "warn" });
    const stored = readStore("remembre.moneynotice.v1", null);
    showMoneyNotice("");
    return { stored, cleared: readStore("remembre.moneynotice.v1", null) };
  });
  check("a notice is kept for the next visit", kept.stored.text, "something happened");
  check("and dismissing it clears that too", kept.cleared, null);
}

{
  const outcomes = await page.evaluate(() =>
    ["connected", "refused", "expired", "no-accounts", "bad-return", "no-store", "failed", "nonsense"]
      .map((name) => ({ name, tone: outcomeText(name).tone, words: outcomeText(name).text.length })));
  check("every outcome has something to say", outcomes.every((o) => o.words > 30), true);
  check("including one nobody wrote down",
    outcomes.find((o) => o.name === "nonsense").tone, "warn");
  check("and the good one is not dressed as a problem",
    outcomes.find((o) => o.name === "connected").tone, "good");
}

/* ---------- The reading, which is part of the page ---------- */

console.log("\nwhat your spending says");

/*
  The server is not running here, so fetch is answered with a canned reply.
  What is being checked is everything around the call: that opening the half
  makes it, that the answer lands in the page rather than on a page of its
  own, that it writes the line under the greeting, and that looking again does
  not pay twice.
*/
const CANNED = {
  analyse: {
    ok: true,
    result: {
      brief: "You have put aside 340,00 zł this month.",
      headline: "Zabka is 70% of your month.",
      verdict: "sustainable",
      working: "Transport is 68 zł against a 120 zł limit.",
      slipping: "Zabka took 400 zł across 20 visits.",
      cut: "Two Zabka runs a week would save about 150 zł a month.",
      change: "The coffee limit is 80 zł and you spend 200. Move it.",
      watch: ["Zabka", "The bus"],
    },
    cost: { in: 1200, out: 300 },
  },
  plan: {
    ok: true,
    result: {
      approach: "Adjusted to what is actually spent.",
      monthly: [{ category: "food", limit: 350, was: 420, why: "Ten percent under last month." }],
      save: { amount: 150, why: "Pay yourself first." },
      tradeoffs: ["One fewer Zabka run a week."],
      year: "1 800 zl over twelve months.",
    },
  },
};

{
  await page.evaluate((csv) => { window.__statement = csv; }, statement({ perDay: 20, income: 1000 }));
  await page.evaluate(async (canned) => {
    window.__calls = [];
    window.fetch = async (url) => {
      window.__calls.push(String(url));
      return { ok: true, json: async () => canned[String(url).includes("action=plan") ? "plan" : "analyse"] };
    };
    state.transactions = [];
    localStorage.removeItem("remembre.insight.v1");
    localStorage.removeItem("remembre.budgetmoves.v1");
    await importCsvText(window.__statement, { label: "for the reading" });
    setArea("school");
  }, CANNED);

  // Opening the half is the whole trigger. There is no page to go to.
  await page.evaluate(() => setArea("money"));
  await page.waitForSelector(".reading-part");

  check("there is no analytics page to go to", await page.locator("[data-money-page]").count(), 0);
  check("it reads the month on opening",
    await page.evaluate(() => window.__calls[0].includes("action=analyse")), true);
  check("and goes on to look at the budgets",
    await page.evaluate(() => window.__calls.some((u) => u.includes("action=plan"))), true);

  const parts = await page.evaluate(() => ({
    titles: [...document.querySelectorAll(".reading-title")].map((n) => n.textContent),
    texts: [...document.querySelectorAll(".reading-text")].map((n) => n.textContent),
    headline: (document.querySelector(".insight-headline") || {}).textContent || "",
    // Read on a Wednesday: Friday to Sunday the line is the weekend purse,
    // which is its own thing and has its own tests.
    brief: briefNow(new Date("2026-10-07T09:00:00")),
    watch: document.querySelectorAll(".watch-list li").length,
  }));

  check("the four questions are answered in order", parts.titles,
    ["Where you do well", "Where you do not", "What to cut", "What to change"]);
  check("where you do well", parts.texts[0], "Transport is 68 zł against a 120 zł limit.");
  check("where you do not", parts.texts[1], "Zabka took 400 zł across 20 visits.");
  check("what to cut", parts.texts[2], "Two Zabka runs a week would save about 150 zł a month.");
  check("what to change", parts.texts[3], "The coffee limit is 80 zł and you spend 200. Move it.");
  check("the headline leads the card", parts.headline, "Zabka is 70% of your month.");
  check("and the brief greets you with it", parts.brief, "You have put aside 340,00 zł this month.");
  check("with what to watch under it", parts.watch, 2);
}

{
  // Nothing is paid twice for the same numbers.
  const calls = await page.evaluate(() => window.__calls.length);
  await page.evaluate(() => { setArea("school"); setArea("money"); });
  await page.waitForTimeout(200);
  check("opening it again does not ask again", await page.evaluate(() => window.__calls.length), calls);

  await page.click("#money-reading .link-btn");
  await page.waitForFunction((was) => window.__calls.length > was, calls);
  check("but asking for it again does",
    await page.evaluate((was) => window.__calls.length > was, calls), true);
}

{
  // Before any of that, and on a train with no signal, there is still a line.
  const local = await page.evaluate(() => {
    localStorage.removeItem("remembre.insight.v1");
    renderGreeting();
    const withoutAi = (document.querySelector(".greeting-brief") || {}).textContent || "";
    state.transactions = [];
    renderGreeting();
    return { withoutAi, empty: (document.querySelector(".greeting-brief") || {}).textContent || "" };
  });
  check("without a reading there is still a brief", local.withoutAi.length > 10, true, local.withoutAi);
  check("and it is made of the numbers on the device", /zł/.test(local.withoutAi), true, local.withoutAi);
  check("with nothing imported it says so", /Nothing imported yet/.test(local.empty), true, local.empty);
}

console.log("\nmoney from outside the plan");

{
  const told = await page.evaluate(async () => {
    localStorage.removeItem("remembre.expected.v1");
    state.transactions = [];
    const when = (back) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - back); return d.toISOString().slice(0, 10); };

    // Looking at the month the wire lands in, which on the 1st or 2nd is not
    // the month the app happens to be showing.
    state.moneyMonth = monthOf(when(2));
    addExpectation({ amount: 50000, date: when(2), what: "concert ticket" });
    const waiting = document.querySelectorAll(".outside-row.is-waiting").length;

    // And then it turns up.
    state.transactions.push(normaliseTransaction({
      id: "the-wire", date: when(2), amount: 50000, counterparty: "BABCIA", category: "income",
    }));
    saveTransactions();
    classifyIncome();
    renderDashboard();

    const wire = liveTransactions().find((e) => e.id === "the-wire");
    return {
      waiting,
      branch: wire.branch,
      met: readStore("remembre.expected.v1", [])[0].metBy,
      stillWaiting: document.querySelectorAll(".outside-row.is-waiting").length,
      listed: (document.querySelector(".outside-row:not(.is-waiting)") || {}).textContent || "",
    };
  });

  check("what is coming can be said in advance", told.waiting, 1);
  check("and when it lands it is outside the plan", told.branch, "external");
  check("without anybody being asked", told.met, "the-wire");
  check("and it stops being something you are waiting for", told.stillWaiting, 0);
  check("the card lists it", /BABCIA/.test(told.listed), true, told.listed);
}

/* ---------- One transaction, up close ---------- */

console.log("\nopening a transaction");

{
  const opened = await page.evaluate(async () => {
    state.transactions = [];
    writeStore("remembre.moneybudgets.v1", "food = 600\nfun = 150");
    writeStore("remembre.incomeplan.v1", DEFAULT_INCOME_PLAN);
    // A fortnight back, so the five of them are in one month whatever day of
    // the month this runs on: a fixture that straddles the first of a month
    // puts half of itself in a report the other half is not in.
    const when = shiftISO(todayISO(), -14);

    // The month, and the one big thing in it that somebody else covered.
    for (let i = 0; i < 4; i += 1) {
      state.transactions.push(normaliseTransaction({
        id: `small-${i}`, date: shiftISO(when, -i - 1), amount: -2000,
        counterparty: "ZABKA", category: "food",
      }));
    }
    state.transactions.push(normaliseTransaction({
      id: "the-big-one", date: shiftISO(when, -2), amount: -90000,
      counterparty: "BILETY NA KONCERT", title: "EBILET", category: "fun", source: "api",
    }));
    saveTransactions();
    state.moneyMonth = monthOf(when);
    moneyChanged();

    openTransaction("the-big-one");
    return {
      open: $("tx-dialog").open === true,
      title: $("tx-dialog-title").textContent,
      figure: document.querySelector(".tx-figure").textContent,
      facts: [...document.querySelectorAll(".tx-facts dt")].map((n) => n.textContent),
      where: [...document.querySelectorAll(".tx-facts dd")][
        [...document.querySelectorAll(".tx-facts dt")].findIndex((n) => n.textContent === "Where it counts")].textContent,
      source: [...document.querySelectorAll(".tx-facts dd")].pop().textContent,
      action: document.querySelector(".dialog-tx .btn-primary").textContent,
      categories: [...document.querySelectorAll("#tx-category option")].map((o) => o.value),
      picked: $("tx-category").value,
    };
  });

  check("a transaction opens", opened.open, true);
  check("named by who was paid", opened.title, "BILETY NA KONCERT");
  check("with the amount set large", /900,00 zł/.test(opened.figure), true, opened.figure);
  check("and the facts under it", opened.facts.includes("When") && opened.facts.includes("Where it counts"), true,
    opened.facts.join(","));
  check("it says where it counts now", /this month's spending/.test(opened.where), true, opened.where);
  check("and where it came from", /mBank, automatically/.test(opened.source), true, opened.source);
  check("the action offered is to move it out", opened.action, "Move it outside the plan");
  check("its category is pickable", opened.categories.includes("food") && opened.categories.includes("fun"), true);
  check("and starts where it is", opened.picked, "fun");
}

{
  // The whole point: the one-off goes out and the day-to-day stops reading wrong.
  const moved = await page.evaluate(() => {
    const month = monthOf(shiftISO(todayISO(), -14));
    const before = { spent: monthReport(month).spent, rate: sustainability().perDay };
    document.querySelector(".dialog-tx .btn-primary").click();
    const entry = liveTransactions().find((e) => e.id === "the-big-one");
    return {
      before,
      after: { spent: monthReport(month).spent, rate: sustainability().perDay },
      branch: entry.branch,
      action: document.querySelector(".dialog-tx .dialog-actions .btn").textContent,
      where: [...document.querySelectorAll(".tx-facts dd")].find((n) => /Outside the plan/.test(n.textContent)),
    };
  });

  check("moving it out takes it off the branch", moved.branch, "external");
  check("the month's spending drops by it", moved.before.spent - moved.after.spent, -90000);
  check("and so does the daily rate", moved.after.rate < moved.before.rate, true);
  check("the dialog now offers the way back", moved.action, "Count it in the month");
  check("and says where it counts now", Boolean(moved.where), true);

  const back = await page.evaluate(() => {
    document.querySelector(".dialog-tx .dialog-actions .btn").click();
    const entry = liveTransactions().find((e) => e.id === "the-big-one");
    classifyIncome();
    return {
      branch: entry.branch, counted: entry.counted,
      spent: monthReport(monthOf(shiftISO(todayISO(), -14))).spent,
    };
  });
  check("counting it back in puts it back", back.branch, "");
  check("and it stays back", back.counted, true);
  check("with the month's spending restored", back.spent, -98000);
}

{
  // A category put right by hand is not undone by the rules on the next import.
  const filed = await page.evaluate(async () => {
    setTransactionCategory("the-big-one", "food");
    const entry = liveTransactions().find((e) => e.id === "the-big-one");
    const after = { category: entry.category, fixed: entry.fixed };
    recategorise();
    const still = liveTransactions().find((e) => e.id === "the-big-one");
    return { after, kept: still.category };
  });
  check("a category can be set by hand", filed.after.category, "food");
  check("it is marked as yours", filed.after.fixed, true);
  check("and the rules leave it alone from then on", filed.kept, "food");

  await page.evaluate(() => closeDialog($("tx-dialog")));
  check("the dialog closes", await page.evaluate(() => $("tx-dialog").open === false), true);
}

{
  // Every list of transactions opens the same way.
  const everywhere = await page.evaluate(() => {
    moneyChanged();
    document.querySelectorAll("details").forEach((fold) => { fold.open = true; });
    return {
      list: document.querySelectorAll("#money-list .tx-open").length,
      biggest: document.querySelectorAll("#money-report .tx-open").length,
    };
  });
  check("the whole list opens", everywhere.list > 0, true);
  check("and so does the biggest-of-the-month list", everywhere.biggest > 0, true);
}

/* ---------- The week, read back ---------- */

console.log("\nthe Sunday debrief, in the page");

{
  const shown = await page.evaluate(() => {
    const sunday = (() => {
      const d = new Date();
      d.setDate(d.getDate() - ((d.getDay() + 7) % 7 || 7));   // the Sunday just gone
      return d.toISOString().slice(0, 10);
    })();

    writeStore("remembre.debrief.v1", [{
      week: shiftISO(sunday, -6),
      sunday,
      at: new Date().toISOString(),
      spent: 31800,
      allowed: 42000,
      result: {
        headline: "A quiet week: 318,00 zł of 420,00 zł.",
        performance: "Weekdays came to 121 zł of 170 allowed. The weekend took 197 zł of 250.",
        kept: "Four days under their limit, which is the best run since the 12th.",
        curb: "Thursday lunches: four of them, 96 zł. Two would save about 190 zł a month.",
        nextWeek: "Take Thursday's lunch from home.",
      },
    }]);
    renderDebrief();

    return {
      shown: !document.querySelector("#money-debrief").hidden,
      headline: (document.querySelector("#money-debrief .insight-headline") || {}).textContent || "",
      titles: [...document.querySelectorAll("#money-debrief .reading-title")].map((n) => n.textContent),
      curb: [...document.querySelectorAll("#money-debrief .reading-text")][2].textContent,
      figures: [...document.querySelectorAll("#money-debrief .chart-caption")].pop().textContent,
    };
  });

  check("the week is shown when there is one", shown.shown, true);
  check("its headline leads", /A quiet week/.test(shown.headline), true, shown.headline);
  check("with the four parts in order", shown.titles,
    ["How the week went", "What went well", "What to curb", "One thing for next week"]);
  check("what to curb is named precisely", /Thursday lunches/.test(shown.curb), true, shown.curb);
  check("and the figures are under it", /318,00 zł spent against 420,00 zł allowed/.test(shown.figures), true,
    shown.figures);
}

{
  // A fortnight on it is history rather than news, and takes itself away.
  const gone = await page.evaluate(() => {
    const old = readStore("remembre.debrief.v1", []);
    old[0].sunday = shiftISO(todayISO(), -20);
    writeStore("remembre.debrief.v1", old);
    renderDebrief();
    return document.querySelector("#money-debrief").hidden;
  });
  check("a fortnight on, it puts itself away", gone, true);

  const none = await page.evaluate(() => {
    writeStore("remembre.debrief.v1", []);
    renderDebrief();
    return document.querySelector("#money-debrief").hidden;
  });
  check("and with none written, there is no empty card", none, true);
}

/* ---------- The cap, and what the months kept ---------- */

console.log("\nthe ceiling under the saving");

{
  // The analysis, asked to make the budgets fit the spending, will drift
  // towards spending everything if nothing stops it.
  const capped = await page.evaluate(async () => {
    state.transactions = [];
    writeStore("remembre.incomeplan.v1", DEFAULT_INCOME_PLAN);
    writeStore("remembre.moneybudgets.v1", "food = 600\nfun = 150");
    writeStore("remembre.budgetmoves.v1", null);

    // Limits that would come to the whole 2 500.
    applyMoves([
      { category: "food", from: 60000, to: 150000, why: "" },
      { category: "fun", from: 15000, to: 100000, why: "" },
    ]);

    const after = parseBudgets(budgetsText());
    return {
      total: [...after.values()].reduce((sum, limit) => sum + limit, 0),
      planned: plannedMonthly(),
      notice: (document.querySelector(".notice-text") || {}).textContent || "",
    };
  });

  check("limits are held under the ceiling", capped.total <= Math.round(capped.planned * 0.8), true,
    `${capped.total} of ${capped.planned}`);
  check("so a fifth of the plan survives as saving", capped.total < capped.planned, true);
  check("and it says it did that", /a fifth is still saved/.test(capped.notice), true, capped.notice);

  // Under the ceiling, nothing is touched.
  const untouched = await page.evaluate(() => {
    writeStore("remembre.moneybudgets.v1", "food = 600\nfun = 150");
    applyMoves([{ category: "food", from: 60000, to: 70000, why: "" }]);
    return parseBudgets(budgetsText()).get("food");
  });
  check("a sensible move is left exactly as it was", untouched, 70000);
}

console.log("\nmoney saved");

{
  const saved = await page.evaluate(async () => {
    state.transactions = [];
    writeStore("remembre.incomeplan.v1", DEFAULT_INCOME_PLAN);
    // The count starts where it was asked to start; this fixture is about the
    // months before that, so it says where.
    writeStore("remembre.savedfrom.v1", "2026-08");
    const add = (date, amount, category) => state.transactions.push(normaliseTransaction({
      id: `${date}-${amount}`, date, amount, category, counterparty: amount > 0 ? "MAMA" : "ZABKA",
    }));

    // Two finished months: one kept something, one did not.
    ["2026-08", "2026-09"].forEach((month, i) => {
      [1, 8, 15, 22].forEach((day, slot) => {
        add(`${month}-${String(day).padStart(2, "0")}`, slot === 0 ? 70000 : 60000, "income");
      });
      add(`${month}-05`, i === 0 ? -100000 : -260000, "food");
    });
    saveTransactions();
    classifyIncome();
    renderSaved();

    const standing = savingsStanding();
    return {
      total: standing.total,
      months: standing.months.map((row) => [row.key, row.saved]),
      best: standing.best ? standing.best.key : "",
      figure: document.querySelector(".saved-figure").textContent,
      rows: document.querySelectorAll(".saved-month").length,
      note: document.querySelector("#money-saved .kpi-note").textContent,
    };
  });

  check("each month's saving is what came in less what went out",
    saved.months, [["2026-08", 150000], ["2026-09", -10000]]);
  check("the box leads with the run of them", saved.total, 140000);
  check("and prints it", /1 400,00 zł/.test(saved.figure), true, saved.figure);
  check("with a row per month", saved.rows, 2);
  check("the best month is named", saved.best, "2026-08");
  check("and it says how many months kept anything", /1 of 2 finished months/.test(saved.note), true, saved.note);
  check("naming where the count starts", /Since August 2026/.test(saved.note), true, saved.note);
}

{
  // Months before the start are not counted and not shown.
  const later = await page.evaluate(() => {
    writeStore("remembre.savedfrom.v1", "2026-09");
    renderSaved();
    const standing = savingsStanding();
    return {
      months: standing.months.map((row) => row.key),
      total: standing.total,
      rows: document.querySelectorAll(".saved-month").length,
    };
  });
  check("an earlier month is left out of the rows", later.months, ["2026-09"]);
  check("and out of the total", later.total, -10000);
  check("with the card showing only what it counts", later.rows, 1);

  const fresh = await page.evaluate(() => {
    writeStore("remembre.savedfrom.v1", "2026-12");
    renderSaved();
    return {
      figure: document.querySelector(".saved-figure").textContent,
      note: document.querySelector("#money-saved .kpi-note").textContent,
    };
  });
  check("a start month with nothing in it yet reads as zero", /0,00 zł/.test(fresh.figure), true, fresh.figure);
  check("and says what it is waiting for", /Counting from December 2026/.test(fresh.note), true, fresh.note);
}

{
  // A month that went backwards is not dressed up as a saving.
  const negative = await page.evaluate(() => {
    // Back to the start month this section built its fixture around.
    writeStore("remembre.savedfrom.v1", "2026-08");
    renderSaved();
    const row = [...document.querySelectorAll(".saved-month")]
      .find((n) => /Sep/.test(n.textContent));
    return { marked: row.className, sum: row.querySelector(".saved-sum").textContent };
  });
  check("a month that lost money is marked as one", /is-negative/.test(negative.marked), true);
  check("and shows the loss", /−100,00 zł/.test(negative.sum), true, negative.sum);
}

console.log("\ntoday's budget on the page");

{
  const today = await page.evaluate(() => {
    state.transactions = [];
    writeStore("remembre.moneybudgets.v1", "food = 600\ntransport = 120\nfun = 180");
    const yesterday = shiftISO(todayISO(), -1);
    const rate = dayBudget(yesterday).base;
    // A quiet yesterday, half spent.
    state.transactions.push(normaliseTransaction({
      id: "quiet", date: yesterday, amount: -Math.round(rate / 2), counterparty: "ZABKA", category: "food",
    }));
    saveTransactions();
    renderDashboard();

    const budget = dayBudget();
    return {
      budget,
      line: (document.querySelector("#money-today") || {}).textContent || "",
      figure: (document.querySelector(".lead-figure") || {}).textContent || "",
      limit: zloty(budget.limit),
      left: zloty(Math.max(0, budget.left)),
      rate,
    };
  });

  check("a quarter of yesterday's underspend lands on today",
    today.budget.carried, Math.round(today.budget.yesterdayLeft / 4));
  check("so today is worth more than its own rate", today.budget.limit > today.budget.base, true);
  // The figure moved out of the fourth card down and into the lead, which is
  // where somebody who opens the app to check one number actually looks.
  check("the half opens on what is left of it", today.figure, today.left);
  check("with the limit it came out of",
    today.line.includes(`spent of ${today.limit} today`), true, today.line);
  check("and where the extra came from", /carried from yesterday/.test(today.line), true, today.line);
}

/* ---------- The week, and the weekend ---------- */

console.log("\nweekdays and the weekend");

{
  const split = await page.evaluate(() => {
    writeStore("remembre.moneybudgets.v1", "food = 600\ntransport = 120\nfun = 180");
    const plan = weekPlan("2026-09");
    const days = daysOfMonth("2026-09");
    return {
      plan,
      days,
      // The split must not change the month. This is the whole promise.
      closes: Math.abs((plan.weekday * days.week + plan.weekend * days.weekend) - plan.spendable) <= days.total,
      ratio: plan.weekend / plan.weekday,
      mondayOf: [weekStart("2026-09-30"), weekStart("2026-09-28"), weekStart("2026-10-04")],
      weekend: [isWeekend("2026-09-25"), isWeekend("2026-09-26"), isWeekend("2026-09-28")],
    };
  });

  check("the month is counted into its two kinds of day",
    split.days.week + split.days.weekend === split.days.total && split.days.total === 30, true);
  // Friday to Sunday: the weekend starts when the money starts being spent.
  check("and three days in seven are the weekend",
    split.days.weekend >= 12 && split.days.weekend <= 14, true);
  check("a weekday costs less than a weekend day", split.plan.weekday < split.plan.weekend, true);
  check("by about four fifths more", Math.abs(split.ratio - 1.8) < 0.02, true);
  // Nothing is saved or lost by the split; it only moves when it may be spent.
  check("and the two rates still come to the month", split.closes, true);
  check("the week starts on Monday", split.mondayOf, ["2026-09-28", "2026-09-28", "2026-09-28"]);
  check("Friday and Saturday are the weekend, Monday is not", split.weekend, [true, true, false]);
}

{
  // A quiet week, read on the Friday morning it was saved for.
  const friday = await page.evaluate(() => {
    const FRIDAY = new Date("2026-10-02T08:00:00");
    const monday = "2026-09-28";
    state.transactions = [];
    writeStore("remembre.moneybudgets.v1", "food = 600\ntransport = 120\nfun = 180");
    const rate = weekPlan("2026-09").weekday;

    for (let i = 0; i < 4; i += 1) {
      state.transactions.push(normaliseTransaction({
        id: `quiet-${i}`, date: shiftISO(monday, i), amount: -Math.round(rate / 2),
        counterparty: "ZABKA", category: "food",
      }));
    }
    saveTransactions();
    return { purse: weekendPurse(FRIDAY), brief: briefNow(FRIDAY) };
  });

  check("only the days that are over are counted", friday.purse.counted, 4);
  check("what was kept back is the difference", friday.purse.saved,
    friday.purse.allowed - friday.purse.spent);
  // Half of the week's underspend, not all of it: a quarter went into the days
  // themselves and a quarter is kept, which is what makes the month save.
  check("half of it is added to the weekend", friday.purse.purse, friday.purse.base + friday.purse.carried);
  check("and the carry is half the saving", friday.purse.carried, Math.round(friday.purse.saved / 2));
  check("Friday morning says what the week put by",
    /kept .* back this week, so the weekend has/.test(friday.brief), true, friday.brief);
  check("with both figures in it", (friday.brief.match(/zł/g) || []).length, 2);
}

{
  // A week that went the other way says so, rather than quietly shrinking.
  const spent = await page.evaluate(() => {
    const FRIDAY = new Date("2026-10-02T08:00:00");
    state.transactions = [];
    const rate = weekPlan("2026-09").weekday;
    for (let i = 0; i < 4; i += 1) {
      state.transactions.push(normaliseTransaction({
        id: `loud-${i}`, date: shiftISO("2026-09-28", i), amount: -(rate * 2),
        counterparty: "ZABKA", category: "food",
      }));
    }
    saveTransactions();
    return { brief: briefNow(FRIDAY), purse: weekendPurse(FRIDAY) };
  });
  check("a week that ran over is said plainly", /ran .* over, so the weekend has/.test(spent.brief), true);
  check("and the weekend is smaller for it", spent.purse.purse < spent.purse.base, true);
}

{
  // Saturday and Sunday ask a different question: what is left.
  const saturday = await page.evaluate(() => {
    const SATURDAY = new Date("2026-10-03T11:00:00");
    state.transactions = [];
    state.transactions.push(normaliseTransaction({
      id: "friday-night", date: "2026-10-02", amount: -8000, counterparty: "KINO", category: "fun",
    }));
    saveTransactions();
    return { brief: briefNow(SATURDAY), purse: weekendPurse(SATURDAY) };
  });
  check("the weekend says what is left of it", /left of the weekend's/.test(saturday.brief), true);
  check("and Friday night came out of it", saturday.purse.weekendSoFar, 8000);

  const tuesday = await page.evaluate(() => briefNow(new Date("2026-09-29T09:00:00")));
  check("a Tuesday gets the ordinary brief", /left of the weekend|kept .* back/.test(tuesday), false);
}

{
  const shown = await page.evaluate(() => {
    renderRateCard();
    return (document.querySelector(".week-line") || {}).textContent || "";
  });
  check("the two rates are on the card the daily figures live on",
    /a weekday · .* a weekend day/.test(shown), true);
  check("with what is riding on them", /for the weekend/.test(shown), true);
}

console.log("\nthe one quotation");

{
  const quote = await page.evaluate(() => {
    renderBalanceCard();
    const note = document.querySelector(".kpi-quote");
    return {
      where: note ? note.closest("section").id : "",
      text: note ? note.textContent : "",
      who: (document.querySelector(".kpi-quote-who") || {}).textContent || "",
      only: document.querySelectorAll(".kpi-quote").length,
    };
  });
  // It belongs on the card about having money, not on the one about spending.
  check("it sits on the balance card", quote.where, "money-balance");
  check("and says what it says",
    /No matter what happens, never lose liquidity/.test(quote.text), true);
  check("with its attribution", quote.who, "Warren Buffett");
  check("once, in one place", quote.only, 1);
}

/* ---------- The interface ---------- */

console.log("\nthe greeting");

{
  const said = await page.evaluate(() => {
    const at = (h) => greetingFor(h);
    renderGreeting(new Date("2026-10-01T09:00:00"));
    return {
      bands: [at(0), at(5), at(11), at(12), at(17), at(18), at(23)],
      shown: document.querySelector(".greeting-hello").textContent,
      name: document.querySelector(".greeting-name").textContent,
      when: document.querySelector(".greeting-when").textContent,
    };
  });
  check("morning, afternoon and evening, by the clock", said.bands,
    ["Good evening", "Good morning", "Good morning", "Good afternoon", "Good afternoon", "Good evening", "Good evening"]);
  check("and it greets you by name", said.shown, "Good morning, Wojciech");
  check("with the name picked out", said.name, "Wojciech");
  check("and today's date beside it",
    /Thursday/.test(said.when) && /1 October/.test(said.when), true, said.when);
}

console.log("\nthe budget map");

{
  const map = await page.evaluate(async (csv) => {
    state.transactions = [];
    writeStore("remembre.moneybudgets.v1", "food = 600\ntransport = 120\nfun = 150");
    writeStore("remembre.incomeplan.v1", DEFAULT_INCOME_PLAN);
    writeStore("remembre.budgetmoves.v1", null);
    await importCsvText(csv, { label: "for the map" });
    state.moneyMonth = monthOf(shiftISO(todayISO(), -14));
    renderBudgetMap();

    const svg = document.querySelector(".budget-map");
    return {
      drawn: Boolean(svg),
      labels: [...svg.querySelectorAll(".map-label")].map((t) => t.textContent),
      figures: [...svg.querySelectorAll(".map-sub")].map((t) => t.textContent),
      flows: svg.querySelectorAll(".map-flow").length,
      nodes: svg.querySelectorAll("rect.map-node:not(.map-source)").length,
      described: svg.getAttribute("aria-label"),
      rows: document.querySelectorAll(".card-map .plain-table tbody tr").length,
      steps: [...svg.querySelectorAll("rect.map-node:not(.map-source)")]
        .filter((r) => r.getAttribute("fill-opacity"))
        .map((r) => r.getAttribute("fill")),
    };
  }, statement({ perDay: 20, income: 700 }));

  check("the plan is drawn as a map", map.drawn, true);
  check("one flow per budget, plus what is left unallocated", map.flows, map.labels.length);
  check("every node is named", map.labels.includes("food") && map.labels.includes("unallocated"), true,
    map.labels.join(","));
  // Whole złoty on a narrow card, to the grosz on a wide one; either way the
  // line says what was spent, of what, and what is left.
  check("and carries both figures",
    / of /.test(map.figures[0]) && /(left|over)/.test(map.figures[0]), true);
  // Each budget draws two rectangles: the budget, and the part of it gone.
  check("what has been spent is drawn inside the node", map.nodes > map.labels.length, true,
    `${map.nodes} rects for ${map.labels.length} rows`);
  check("the biggest budget gets the brightest step", map.steps[0], "var(--seq-5)");
  check("a screen reader is told what it says", /How 2500 zloty of plan is divided/.test(map.described), true);
  check("and the same map is available as a table", map.rows, map.labels.length);
}

{
  // Spending with no budget is the thing a plan most needs to know about.
  const loose = await page.evaluate(() => {
    writeStore("remembre.moneybudgets.v1", "transport = 120");
    renderBudgetMap();
    const names = [...document.querySelectorAll(".map-label")].map((t) => t.textContent);
    const note = [...document.querySelectorAll(".map-sub")]
      .find((t) => /no budget/.test(t.textContent));
    return { names, note: note ? note.textContent : "", tone: note ? note.getAttribute("class") : "" };
  });
  check("spending with no budget is a node of its own", loose.names.includes("not budgeted"), true,
    loose.names.join(","));
  check("and says so in words", /spent, no budget/.test(loose.note), true, loose.note);
  check("marked the way an overspend is", /is-over/.test(loose.tone), true);
}

console.log("\nthe analysis moving the budgets");

{
  const moved = await page.evaluate(async () => {
    writeStore("remembre.moneybudgets.v1", "food = 600\ncoffee = 80\nfun = 150");
    writeStore("remembre.autobudget.v1", true);
    writeStore("remembre.budgetmoves.v1", null);
    writeStore("remembre.budgetsbefore.v1", null);

    // What the analysis came back with: the coffee limit was always wrong.
    window.fetch = async (url) => ({
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          approach: "Moved to where the money goes.",
          monthly: [
            { category: "coffee", limit: 200, was: 210, why: "14 visits a month; 80 was never going to hold." },
            { category: "fun", limit: 70, was: 40, why: "Room to take it from." },
            { category: "food", limit: 600, was: 480, why: "Unchanged." },
          ],
          save: { amount: 200, why: "First." },
          tradeoffs: [], year: "",
        },
      }),
    });

    await rebalanceBudgets({ byHand: true });
    return {
      budgets: readStore("remembre.moneybudgets.v1", ""),
      moves: readStore("remembre.budgetmoves.v1", null),
      notice: (document.querySelector(".notice-text") || {}).textContent || "",
      undo: (document.querySelector(".notice-acts .btn") || {}).textContent || "",
      shown: [...document.querySelectorAll(".move-cat")].map((n) => n.textContent),
      why: (document.querySelector(".move-why") || {}).textContent || "",
    };
  });

  check("a limit that is always wrong is raised", /coffee = 200/.test(moved.budgets), true, moved.budgets);
  check("and the room is taken from one with slack", /fun = 70/.test(moved.budgets), true);
  check("a limit that was right is left alone", /food = 600/.test(moved.budgets), true);
  check("only what changed counts as a move", moved.shown.sort(), ["coffee", "fun"]);
  check("each move says what it is really about", /14 visits a month/.test(moved.why), true, moved.why);
  check("it is applied without being asked", moved.moves.applied, true);
  check("and said out loud where it can be seen", /Budgets adjusted/.test(moved.notice), true, moved.notice);
  check("with one tap to put it back", moved.undo, "Undo");

  const back = await page.evaluate(() => {
    undoMoves();
    return {
      budgets: readStore("remembre.moneybudgets.v1", ""),
      applied: readStore("remembre.budgetmoves.v1", null).applied,
    };
  });
  check("undo puts the old limits back", /coffee = 80/.test(back.budgets), true, back.budgets);
  check("and the map stops claiming they were applied", back.applied, false);
}

{
  // There is no switch to turn off. A switch is a question in a hat: it asks
  // you, every time you see it, whether you still mean what you already said.
  const always = await page.evaluate(async () => {
    writeStore("remembre.moneybudgets.v1", "food = 600\ncoffee = 80\nfun = 150");
    writeStore("remembre.budgetmoves.v1", null);
    await rebalanceBudgets({ byHand: true });
    return {
      budgets: readStore("remembre.moneybudgets.v1", ""),
      applied: readStore("remembre.budgetmoves.v1", null).applied,
      button: (document.querySelector(".card-map .panel-actions .btn") || {}).textContent || "",
      switches: document.querySelectorAll(".auto-row, #auto-budget").length,
    };
  });
  check("the moves land without being asked about", /coffee = 200/.test(always.budgets), true, always.budgets);
  check("and are marked as applied", always.applied, true);
  check("what is offered is the way back", always.button, "Put them back");
  check("and there is no switch to argue with", always.switches, 0);
}

console.log("\nopening the half is the refresh");

{
  /*
    What the bank is asked, and when. The stub answers for the three routes a
    refresh touches -- the consent, the fetch, and the sync that carries what
    the fetch wrote -- and keeps a list, because the point of all this is which
    calls happen on their own.
  */
  const setup = async () => page.evaluate(() => {
    writeStore("remembre.cloud.v1", { code: "vault-phrase-here", enabled: true, feed: "" });
    localStorage.removeItem("remembre.bankasked.v1");
    window.__asked = [];
    window.__arrival = {
      id: "from-the-bank", date: todayISO(), amount: -1900, counterparty: "ZABKA",
      note: "ZABKA Z1", category: "", source: "api", deleted: false,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    window.__failFetch = false;
    window.fetch = async (url) => {
      const at = String(url);
      window.__asked.push(at);
      if (at.includes("action=status")) {
        return { ok: true, json: async () => ({
          ok: true, connected: true, expired: false,
          accounts: [{ name: "eKonto", iban: "\u20268067" }],
          validUntil: "2027-01-01T00:00:00.000Z",
          fetchedTo: todayISO(), lastFetchAt: new Date().toISOString(),
          balance: null,
        }) };
      }
      if (at.includes("action=fetch")) {
        if (window.__failFetch) {
          return { ok: false, json: async () => ({ ok: false, message: "mBank is having a morning." }) };
        }
        return { ok: true, json: async () => ({ ok: true, read: 9, added: 1, from: shiftISO(todayISO(), -5) }) };
      }
      if (at.includes("/api/sync")) {
        return { ok: true, json: async () => ({
          ok: true, feed: "", vault: { tasks: [], coursework: [], sessions: [], transactions: [window.__arrival] },
        }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    };
    setArea("school");
  });

  await setup();
  await page.evaluate(() => setArea("money"));
  await page.waitForFunction(() => window.__asked.some((u) => u.includes("action=fetch")));

  const first = await page.evaluate(() => ({
    status: window.__asked.filter((u) => u.includes("action=status")).length,
    fetched: window.__asked.filter((u) => u.includes("action=fetch")).length,
    arrived: state.transactions.some((entry) => entry.id === "from-the-bank"),
  }));
  check("opening the half asks the bank for anything new", first.fetched, 1);
  check("not only whether the consent is alive", first.status > 0, true);
  check("and what it hands back is on the page without asking again", first.arrived, true);

  // Flicking between the halves is not a reason to call a bank.
  const again = await page.evaluate(async () => {
    setArea("school");
    await moneyOpened();
    await moneyOpened();
    return window.__asked.filter((u) => u.includes("action=fetch")).length;
  });
  check("opening it again straight away does not ask twice", again, 1);

  const byHand = await page.evaluate(async () => {
    await pullBank({ force: true, loud: true });
    return {
      fetched: window.__asked.filter((u) => u.includes("action=fetch")).length,
      said: (document.querySelector("#money-notice") || {}).textContent || "",
    };
  });
  check("the button is not held to the cooldown", byHand.fetched, 2);
  check("and says what it found", /1 new transaction from mBank/.test(byHand.said), true, byHand.said);

  // How long ago, in the units a refresh-on-opening actually moves in.
  const words = await page.evaluate(() => {
    const now = Date.now();
    return [
      freshness(new Date(now - 20 * 1000).toISOString()),
      freshness(new Date(now - 60 * 1000).toISOString()),
      freshness(new Date(now - 14 * 60 * 1000).toISOString()),
      freshness(new Date(now - 2 * 3600 * 1000).toISOString()),
      freshness(""),
    ];
  });
  check("the reading is dated in minutes, not days",
    words, ["just now", "a minute ago", "14 minutes ago", "2 hours ago", ""]);
  check("and the card says when the bank was last heard from",
    /last checked just now/.test(await page.evaluate(() => document.querySelector(".kpi-bank").textContent)),
    true, await page.evaluate(() => document.querySelector(".kpi-bank").textContent));

  // A bank that will not answer is not worth a banner over a page you have
  // only just opened. The status line is where that belongs.
  const quiet = await page.evaluate(async () => {
    window.__failFetch = true;
    localStorage.removeItem("remembre.bankasked.v1");
    showMoneyNotice("", { tone: "plain" });
    const before = (document.querySelector("#money-notice") || {}).textContent || "";
    await pullBank();
    return {
      before,
      after: (document.querySelector("#money-notice") || {}).textContent || "",
      figure: (document.querySelector(".kpi-figure") || {}).textContent || "",
    };
  });
  check("an automatic pull that fails says nothing", quiet.after, quiet.before);
  check("and leaves the figures standing", quiet.figure.length > 0, true);

  const loud = await page.evaluate(async () => {
    localStorage.removeItem("remembre.bankasked.v1");
    await pullBank({ force: true, loud: true });
    return (document.querySelector("#money-notice") || {}).textContent || "";
  });
  check("asked for by hand, the same failure is reported",
    /mBank would not hand anything over/.test(loud), true, loud);

  await page.evaluate(() => { window.__failFetch = false; });
}

{
  // Midnight. Every figure here is relative to today, so a page left open
  // overnight is a page of yesterday's arithmetic.
  const rolled = await page.evaluate(() => {
    const today = todayISO();
    const lastMonth = monthOf(shiftISO(today, -40));
    // As if the app had been open since the previous month.
    moneySeenDay = shiftISO(today, -40);
    state.moneyMonth = lastMonth;
    const moved = moneyDayRolled();
    const followed = state.moneyMonth;

    // And somebody who stepped back to look at an older month on purpose is
    // left where they put themselves.
    moneySeenDay = shiftISO(today, -40);
    state.moneyMonth = monthOf(shiftISO(today, -200));
    moneyDayRolled();
    return { moved, followed, today: monthOf(today), kept: state.moneyMonth,
      picked: monthOf(shiftISO(today, -200)), nothing: moneyDayRolled() };
  });
  check("the day turning over redraws the half", rolled.moved, true);
  check("and a new month moves the month with it", rolled.followed, rolled.today);
  check("a month you stepped back to is left alone", rolled.kept, rolled.picked);
  check("and a day that has not turned over redraws nothing", rolled.nothing, false);
}

check("no console or page errors", problems, []);

await browser.close();
server.close();

if (failures.length) {
  console.error(`\n${failures.length} failed:\n` + failures.map((f) => `  - ${f}`).join("\n\n"));
  process.exit(1);
}
console.log(`\n${checks}/${checks} checks passed.`);
