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
  check("and the calendar's controls step aside",
    await page.locator("#add-task-top").isVisible(), false);
  check("the transactions are listed",
    await page.locator(".tx").count(), 6);
  check("the newest first",
    (await page.locator(".tx .tx-date").first().innerText()).trim(), "09-28");
  check("with amounts in złoty",
    (await page.locator(".tx .tx-amount").first().innerText()).includes("12,49"), true);
  // A column of figures that sometimes groups and sometimes does not is worse
  // than one that never does, so the grouping is ours rather than the browser's.
  check("and thousands grouped the Polish way",
    await page.evaluate(() => [zloty(120000), zloty(-1234567), zloty(5)]),
    ["1\u00a0200,00 z\u0142", "\u221212\u00a0345,67 z\u0142", "0,05 z\u0142"]);

  await page.click("#area-back");
  check("switching goes back to the choice", await page.locator("#chooser").isVisible(), true);

  await page.click('[data-area="school"]');
  check("and schoolwork still opens", await page.locator("#school-area").isVisible(), true);
  check("with its controls back", await page.locator("#add-task-top").isVisible(), true);
  check("and the timetable drawn", await page.locator(".tt-lesson").count() > 0, true);
}

check("no console or page errors", problems, []);

await browser.close();
server.close();

if (failures.length) {
  console.error(`\n${failures.length} failed:\n` + failures.map((f) => `  - ${f}`).join("\n\n"));
  process.exit(1);
}
console.log(`\n${checks}/${checks} checks passed.`);
