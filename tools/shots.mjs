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

    const shot = async (label) => page.screenshot({
      path: join(out, `${label}-${name}-${theme}.png`), fullPage: true,
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

    await context.close();
  }
}

await browser.close();
server.close();
console.log(`shots in ${out}`);
