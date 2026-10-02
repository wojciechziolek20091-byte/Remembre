/*
  The welcome is the one screen that can ruin the app outright: if it ever
  fails to leave, there is nothing to press and no way past it. So these are
  less about how it looks than about it always, always going away -- on a
  second launch, with animation refused, with storage refused, and with the
  animation never reporting that it finished.

  Run: node tools/welcome-test.mjs
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
  ".png": "image/png",
  ".json": "application/json",
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
async function launch(options = {}) {
  // A fresh context is a fresh launch: that is what earns the animation.
  const context = await browser.newContext({ viewport: { width: 900, height: 700 }, ...options });
  const page = await context.newPage();
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  await page.goto(base);
  return { context, page };
}

const gone = (page) => page.evaluate(() => !document.getElementById("welcome"));

/* ---------- The first launch ---------- */

console.log("\nthe first launch");

{
  const { context, page } = await launch();

  check("the welcome is up straight away", await page.locator("#welcome").isVisible(), true);
  check("the name is on it", (await page.textContent(".welcome-name")).trim(), "Get a grip");
  check("and the signature", (await page.textContent(".welcome-signature")).trim(), "by Wojciech Ziolek");
  check("it is not announced to a screen reader",
    await page.getAttribute("#welcome", "aria-hidden"), "true");
  check("and it swallows nothing that is aimed past it",
    await page.evaluate(() => getComputedStyle(document.getElementById("welcome")).pointerEvents),
    "none");
  check("the page cannot be scrolled under it",
    await page.evaluate(() => document.body.classList.contains("is-booting")), true);

  // The app is built and waiting behind it, so nothing is delayed by the show.
  check("the app is already there behind it",
    await page.evaluate(() => document.querySelectorAll(".tt-lesson").length > 0), true);

  check("at a second it is still showing", await gone(page), false);

  await page.waitForFunction(() => !document.getElementById("welcome"), null, { timeout: 5000 });
  check("and it has gone by four seconds", await gone(page), true);
  check("leaving the page free to scroll",
    await page.evaluate(() => document.body.classList.contains("is-booting")), false);
  check("and the choice of halves is what it hands over to",
    await page.locator("#chooser").isVisible(), true);

  await context.close();
}

/* ---------- Not twice in a row ---------- */

console.log("\ncoming back to it");

{
  const { context, page } = await launch();
  await page.waitForFunction(() => !document.getElementById("welcome"), null, { timeout: 5000 });

  await page.click('[data-area="school"]');
  await page.reload();
  await page.waitForSelector(".tt-lesson");
  check("a reload in the same session does not sit through it again",
    await gone(page), true);
  check("and the page is not left locked", 
    await page.evaluate(() => document.body.classList.contains("is-booting")), false);
  await context.close();
}

{
  const { context, page } = await launch();
  await page.waitForFunction(() => !document.getElementById("welcome"), null, { timeout: 5000 });
  await context.close();

  const relaunched = await launch();
  check("but a fresh launch earns it again",
    await relaunched.page.locator("#welcome").isVisible(), true);
  await relaunched.context.close();
}

/* ---------- Asked for stillness ---------- */

console.log("\nwith motion turned down");

{
  const { context, page } = await launch({ reducedMotion: "reduce" });
  check("it still says hello", await page.locator("#welcome").isVisible(), true);

  const started = Date.now();
  await page.waitForFunction(() => !document.getElementById("welcome"), null, { timeout: 5000 });
  const took = Date.now() - started;
  check("but is over in well under half the time", took < 2000, true);
  await context.close();
}

/* ---------- When things are refused ---------- */

console.log("\nwhen the browser refuses things");

{
  // A private window can throw on sessionStorage rather than return null. The
  // welcome must not be what breaks.
  const { context, page } = await browser.newContext({ viewport: { width: 900, height: 700 } })
    .then(async (ctx) => {
      await ctx.addInitScript(() => {
        Object.defineProperty(window, "sessionStorage", {
          get() { throw new Error("denied"); },
        });
      });
      const p = await ctx.newPage();
      p.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
      await p.goto(base);
      return { context: ctx, page: p };
    });

  await page.waitForFunction(() => !document.getElementById("welcome"), null, { timeout: 6000 });
  check("with storage refused it still leaves", await gone(page), true);
  check("and the app still works",
    await page.evaluate(() => document.querySelectorAll("[data-area]").length), 2);
  await context.close();
}

{
  // The belt-and-braces case: the animation never reports finishing.
  const { context, page } = await browser.newContext({ viewport: { width: 900, height: 700 } })
    .then(async (ctx) => {
      await ctx.addInitScript(() => {
        const real = EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener = function (type, ...rest) {
          if (type === "animationend") return undefined;
          return real.call(this, type, ...rest);
        };
      });
      const p = await ctx.newPage();
      await p.goto(base);
      return { context: ctx, page: p };
    });

  await page.waitForFunction(() => !document.getElementById("welcome"), null, { timeout: 8000 });
  check("and the safety net catches an animation that never ends", await gone(page), true);
  await context.close();
}

/* ---------- Done ---------- */

/* ---------- Choosing a half ---------- */

console.log("\nchoosing one of the two");

const { context: chooseContext, page } = await launch();
await page.waitForSelector("#chooser", { state: "visible", timeout: 8000 });

{
  const chooser = await page.evaluate(() => {
    setArea("");
    const tiles = [...document.querySelectorAll(".chooser-tiles .tile")];
    return {
      count: tiles.length,
      // Staggered, so the eye is led across them in the order they are read.
      delays: tiles.map((tile) => getComputedStyle(tile).animationDelay),
      named: tiles.map((tile) => getComputedStyle(tile).animationName),
      title: getComputedStyle(document.querySelector(".chooser-title")).animationName,
    };
  });

  check("both tiles arrive rather than appear", chooser.named, ["tile-arrive", "tile-arrive"]);
  check("the second a beat behind the first", chooser.delays, ["0.07s", "0.15s"]);
  check("and the title comes up with them", chooser.title, "chooser-rise");
}

{
  // The state changes at once; what stands in front of it is a curtain.
  // Nothing downstream waits on it, and nothing can be caught half-switched.
  await page.click('[data-area="money"]');
  const during = await page.evaluate(() => {
    const curtain = document.querySelector(".area-curtain");
    return {
      money: !document.getElementById("money-area").hidden,
      chooser: !document.getElementById("chooser").hidden,
      curtains: document.querySelectorAll(".area-curtain").length,
      named: (document.querySelector(".curtain-what") || {}).textContent,
      ring: Boolean(document.querySelector(".curtain-arcs")),
      hidden: curtain ? curtain.getAttribute("aria-hidden") : "",
      // The curtain takes the colour of the half arriving behind it.
      ground: curtain ? getComputedStyle(curtain).backgroundColor : "",
      bodyGround: getComputedStyle(document.body).backgroundColor,
    };
  });

  check("the half is open on the same tick as the tap", during.money, true);
  check("and the chooser is already gone", during.chooser, false);
  check("a curtain stands in front of it", during.curtains, 1);
  check("saying which half is coming", during.named, "Money");
  check("with the app's own ring turning on it", during.ring, true);
  check("and nothing on it for a screen reader", during.hidden, "true");
  // The money half is dark; the curtain is dark with it, so there is no flash
  // of paper on the way in.
  check("it takes the colour of the half arriving", during.ground, during.bodyGround);

  await page.waitForFunction(() => document.querySelectorAll(".area-curtain").length === 0, null,
    { timeout: 4000 });
  check("the curtain lifts by itself", await page.evaluate(() =>
    document.querySelectorAll(".area-curtain").length), 0);
  check("leaving the half it covered", await page.evaluate(() =>
    !document.getElementById("money-area").hidden), true);
}

{
  // Long enough to read as deliberate, never long enough to feel stuck.
  await page.evaluate(() => setArea(""));
  await page.waitForTimeout(200);
  const held = await page.evaluate(async () => {
    const started = performance.now();
    document.querySelector('[data-area="school"]').click();
    await new Promise((done) => {
      const watch = new MutationObserver(() => {
        if (!document.querySelector(".area-curtain")) { watch.disconnect(); done(); }
      });
      watch.observe(document.body, { childList: true });
    });
    return Math.round(performance.now() - started);
  });
  check("the beat is long enough to be read", held >= 500, true, `${held}ms`);
  check("and short enough not to be waited on", held <= 2200, true, `${held}ms`);
}

{
  // Choosing the same half twice in a row still animates: the class is taken
  // off and put back with a reflow between, or the second arrival is silent.
  await page.evaluate(() => setArea(""));
  await page.click('[data-area="money"]');
  await page.waitForFunction(() => document.querySelectorAll(".area-curtain").length === 0, null,
    { timeout: 4000 });
  check("choosing it again animates again",
    await page.evaluate(() => document.querySelectorAll(".area-arriving").length), 1);
}

{
  // Asked to stay still, it is a change of state and nothing else.
  const still = await browser.newContext({
    viewport: { width: 900, height: 700 }, reducedMotion: "reduce",
  });
  const quiet = await still.newPage();
  await quiet.addInitScript(() => {
    try { sessionStorage.setItem("getagrip.welcomed", "yes"); } catch (err) { /* no storage, no matter */ }
  });
  await quiet.goto(base);
  await quiet.waitForSelector("#chooser");
  await quiet.click('[data-area="school"]');

  check("with motion turned down, no curtain is made",
    await quiet.evaluate(() => document.querySelectorAll(".area-curtain").length), 0);
  check("and the half is open all the same",
    await quiet.evaluate(() => !document.getElementById("school-area").hidden), true);
  check("with the tiles not animated",
    await quiet.evaluate(() => {
      setArea("");
      return getComputedStyle(document.querySelector(".chooser-tiles .tile")).animationName;
    }), "none");
  await still.close();
}

await chooseContext.close();

check("no page errors throughout", problems, []);

await browser.close();
server.close();

if (failures.length) {
  console.error(`\n${failures.length} failed:\n` + failures.map((f) => `  - ${f}`).join("\n\n"));
  process.exit(1);
}
console.log(`\n${checks}/${checks} checks passed.`);
