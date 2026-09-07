/*
  End-to-end test of the "a new version is ready" flow.

  Serves a throwaway copy of the site, lets a worker take control, then edits
  sw.js on disk exactly as a deploy would. Asserts that the new worker waits
  rather than taking over, that the reader is offered the update, and that
  accepting it actually lands the page on the new version.

  Run with:  npm test
*/

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, writeFile, mkdtemp, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const site = await mkdtemp(join(tmpdir(), "remembre-update-"));

for (const entry of ["index.html", "styles.css", "app.js", "sw.js", "favicon.svg", "manifest.webmanifest", "fonts", "icons"]) {
  await cp(join(root, entry), join(site, entry), { recursive: true });
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json",
};

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  const file = join(site, path === "/" ? "index.html" : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[file.slice(file.lastIndexOf("."))] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
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
const context = await browser.newContext();
const page = await context.newPage();

console.log("\nupdate bar");

await page.goto(base);
await page.waitForSelector(".day");
await page.evaluate(() => navigator.serviceWorker.ready);
// Reload so the page starts out controlled, as an installed app always is.
await page.reload();
await page.waitForSelector(".day");
await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
check("the bar stays out of the way when nothing has changed", await page.locator("#update-bar").isVisible(), false);

const before = await page.evaluate(() => document.querySelector(".signature").textContent);

// A deploy: the worker and a visible asset both change on disk.
await writeFile(join(site, "sw.js"), (await readFile(join(site, "sw.js"), "utf8")).replace('"remembre-v2"', '"remembre-v3"'));
await writeFile(join(site, "index.html"), (await readFile(join(site, "index.html"), "utf8")).replace("by Wojciech Ziolek", "by A New Version"));

await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; await r.update(); });
await page.waitForSelector("#update-bar:visible", { timeout: 20000 });
check("the reader is told a new version is ready", await page.locator("#update-bar").isVisible(), true);
// announce() clears the live region and fills it a moment later, so that a
// screen reader re-reads it; wait for that rather than racing it.
const announced = await page
  .waitForFunction(() => document.getElementById("live-region").textContent.includes("new version"), null, { timeout: 5000 })
  .then(() => true, () => false);
check("and it is announced", announced, true);
check("the new worker waits instead of taking over",
  await page.evaluate(async () => Boolean((await navigator.serviceWorker.ready).waiting)), true);
check("the page is still showing the old version", await page.evaluate(() =>
  document.querySelector(".signature").textContent), before);

console.log("\npostponing");
await page.click("#update-dismiss");
check("Later hides the bar", await page.locator("#update-bar").isVisible(), false);
check("and moves focus somewhere usable",
  await page.evaluate(() => document.activeElement.id), "add-task-top");

console.log("\naccepting");
await page.evaluate(() => { document.getElementById("update-bar").hidden = false; });
await Promise.all([
  page.waitForNavigation({ timeout: 20000 }),
  page.click("#update-reload"),
]);
await page.waitForSelector(".day");
check("reloading lands on the new version",
  await page.evaluate(() => document.querySelector(".signature").textContent), "by A New Version");
check("the bar is gone afterwards", await page.locator("#update-bar").isVisible(), false);
check("and nothing is left waiting",
  await page.evaluate(async () => Boolean((await navigator.serviceWorker.ready).waiting)), false);

await browser.close();
server.close();

console.log(`\n${checks - failures.length}/${checks} checks passed.`);
if (failures.length > 0) {
  console.log(`\n${failures.map((f) => `  - ${f}`).join("\n")}\n`);
  process.exit(1);
}
