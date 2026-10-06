/*
  Screenshots, for looking at the thing.

  Serves the site, fills it with enough plausible work and spending to be worth
  photographing, and writes a PNG per surface per theme per device into
  docs/shots/. Design work done by reading CSS is design work done blind.

  Run with:  node tools/shots.mjs [outDir]
  Set CHROMIUM_PATH if Playwright's bundled browser is not installed.
*/

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.argv[2] || join(root, "docs", "shots");
await mkdir(out, { recursive: true });

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".json": "application/json", ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  const file = join(root, path === "/" ? "index.html" : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[file.slice(file.lastIndexOf("."))] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
);

/* Three weeks of a student's spending, ending yesterday. */
function statement({ days = 21, perDay = 23, income = 700, closing = 1740 } = {}) {
  const day = (back) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - back);
    return date.toISOString().slice(0, 10);
  };
  const rows = [];
  for (let back = days; back >= 1; back -= 1) {
    rows.push(`${day(back)};${day(back)};PLATNOSC KARTA;ZABKA Z1;ZABKA;;-${perDay},00 PLN;0,00 PLN`);
    if (back % 3 === 0) rows.push(`${day(back)};${day(back)};PLATNOSC KARTA;BILET MPK KRAKOW;MPK;;-4,00 PLN;0,00 PLN`);
    if (back % 7 === 0) rows.push(`${day(back)};${day(back)};PLATNOSC KARTA;KINO KIJOW;KINO;;-32,00 PLN;0,00 PLN`);
    if (back % 5 === 0) rows.push(`${day(back)};${day(back)};PLATNOSC KARTA;COSTA COFFEE;COSTA;;-16,00 PLN;0,00 PLN`);
  }
  rows.push(`${day(days)};${day(days)};PRZELEW PRZYCHODZACY;Kieszonkowe;JAN ZIOLEK;;${income},00 PLN;0,00 PLN`);
  return [
    "#Numer rachunku;", "PL61109010140000071219812874;", "",
    "#Data operacji;#Data ksiegowania;#Opis operacji;#Tytul;#Nadawca/Odbiorca;#Numer konta;#Kwota;#Saldo po operacji",
    ...rows, "", `#Saldo koncowe;;;;;;${closing},00 PLN;`,
  ].join("\r\n");
}

const DEVICES = {
  ipad: { width: 1024, height: 1366, deviceScaleFactor: 2 },
  iphone: { width: 390, height: 844, deviceScaleFactor: 2 },
};

for (const theme of ["light", "dark"]) {
  for (const [name, viewport] of Object.entries(DEVICES)) {
    const context = await browser.newContext({ viewport, colorScheme: theme });
    const page = await context.newPage();
    await page.addInitScript(() => {
      try {
        sessionStorage.setItem("getagrip.welcomed", "yes");
      } catch (err) { /* storage refused is not a reason to stop */ }
    });
    await page.goto(base);
    await page.waitForSelector("#chooser");
    await page.evaluate(() => document.fonts.ready);

    const shot = async (label, { full = true } = {}) => page.screenshot({
      path: join(out, `${label}-${name}-${theme}.png`), fullPage: full,
    });

    await shot("1-chooser");

    await page.evaluate(async (csv) => {
      writeStore("remembre.moneybudgets.v1", "food = 420\ntransport = 90\ncoffee = 70\nfun = 160");
      state.transactions = [];
      await importCsvText(csv, { label: "a statement" });
      setArea("money");
    }, statement());
    await page.waitForTimeout(600);
    await shot("2-money");

    await page.evaluate(() => setArea("school"));
    await page.waitForTimeout(400);
    await shot("3-school");

    // And the choice again, now that both halves have something to say.
    await page.evaluate(() => setArea(""));
    await page.waitForTimeout(600);
    await shot("4-chooser-live");

    // The sitting: offered, run, and reported back.
    await page.evaluate(() => {
      const today = todayISO();
      state.coursework = [normaliseCoursework({
        id: "ia", title: "Economics IA", kind: "ia", subject: "economics",
        due: addDays(today, 18), stage: "in-progress",
        steps: [{ id: "s2", title: "Write the commentary", due: addDays(today, 16), done: false, hours: 9 }],
        createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      })];
      state.sessions = [normaliseSession({
        id: "tonight", courseworkId: "ia", stepId: "s2", date: today, time: "19:00", minutes: 90,
        why: "Long enough to get a section drafted", by: "ai",
        createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      })];
      saveCoursework(); saveSessions();
      try { sessionStorage.removeItem("getagrip.offered"); } catch (err) { /* nothing */ }
      setArea("school");
      offerSession({ force: true });
    });
    await page.waitForTimeout(400);
    await shot("5-offered", { full: false });

    await page.evaluate(() => {
      closeDialog(document.getElementById("session-dialog"));
      startSession("tonight", { now: new Date(Date.now() - 37 * 60000) });
    });
    await page.waitForTimeout(400);
    // The clock covers the screen rather than the document, so a full-page
    // shot of it would be a picture of the page it is covering.
    await shot("6-timer", { full: false });

    // Leaving the clock leaves the bar, which is the live one.
    await page.evaluate(() => { hideTimer(); drawTimer(); });
    await page.waitForTimeout(300);
    await shot("7-live", { full: false });

    await page.evaluate(() => {
      endSession({ finished: false });
      openCheckin({ because: "finished" });
    });
    await page.waitForTimeout(300);
    await shot("8-checkin", { full: false });

    await context.close();
  }
}

await browser.close();
server.close();
console.log(`shots in ${out}`);
