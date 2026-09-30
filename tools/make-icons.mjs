/*
  Renders the app icons from the same geometry as favicon.svg, so the mark can
  never drift between the tab, the home screen and the splash.

  Run: node tools/make-icons.mjs
  Set CHROMIUM_PATH if Playwright's bundled browser is not installed.
*/

import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const INK = "#141011";
const GRIP = "#D4374F";
const CENTRE = "#F7DFC9";

const SEGMENTS = [
  "M36.84 12.59A20 20 0 0 1 51.23 37.51",
  "M46.39 45.89A20 20 0 0 1 17.61 45.89",
  "M12.77 37.51A20 20 0 0 1 27.16 12.59",
];

/**
 * `inset` leaves room for the circular mask a launcher may apply: a maskable
 * icon can have its corners cropped hard, so the mark has to sit well inside.
 */
function mark({ radius, inset }) {
  const scale = 1 - inset * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="${radius}" fill="${INK}"/>
  <g transform="translate(${(64 * inset).toFixed(2)} ${(64 * inset).toFixed(2)}) scale(${scale})">
    <g fill="none" stroke="${GRIP}" stroke-width="6.5" stroke-linecap="round">
      ${SEGMENTS.map((d) => `<path d="${d}"/>`).join("\n      ")}
    </g>
    <circle cx="32" cy="32" r="5.5" fill="${CENTRE}"/>
  </g>
</svg>`;
}

const ICONS = [
  { file: "icons/icon-192.png", size: 192, radius: 14, inset: 0 },
  { file: "icons/icon-512.png", size: 512, radius: 14, inset: 0 },
  // Full bleed, mark pulled in: a maskable icon is cropped by the launcher.
  { file: "icons/icon-maskable-512.png", size: 512, radius: 0, inset: 0.14 },
  // iOS applies its own rounding, so this one must be square to the edge.
  { file: "icons/apple-touch-icon.png", size: 180, radius: 0, inset: 0.08 },
];

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
);

for (const icon of ICONS) {
  const page = await browser.newPage({
    viewport: { width: icon.size, height: icon.size },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    `<body style="margin:0;width:${icon.size}px;height:${icon.size}px">` +
    mark(icon).replace("<svg", `<svg width="${icon.size}" height="${icon.size}"`) +
    "</body>"
  );
  await page.screenshot({ path: join(root, icon.file), omitBackground: false });
  await page.close();
  console.log(`${icon.file}  ${icon.size}x${icon.size}`);
}

await writeFile(join(root, "favicon.svg"), mark({ radius: 14, inset: 0 }).replace(
  "<svg xmlns", '<svg role="img" aria-label="Get a grip" xmlns'
) + "\n");
console.log("favicon.svg");

await browser.close();
