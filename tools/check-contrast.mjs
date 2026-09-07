/*
  Reads the colour tokens out of styles.css and checks every foreground /
  background pair the interface actually uses against WCAG 2.1.

  Run with:  node tools/check-contrast.mjs
  Exits non-zero if any pair falls short, so it can be wired into CI.
*/

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "styles.css"), "utf8");

/** Pull the token block for a selector into a flat map. */
function tokens(selectorPattern) {
  const match = css.match(selectorPattern);
  if (!match) throw new Error(`Could not find token block for ${selectorPattern}`);
  const map = {};
  for (const [, name, value] of match[1].matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    map[name] = value.trim();
  }
  return map;
}

const light = tokens(/:root \{\s*color-scheme: light;([\s\S]*?)\n\}/);
const dark = tokens(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);

function toRgb(hex) {
  const clean = hex.replace("#", "").trim();
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

function luminance(hex) {
  const [r, g, b] = toRgb(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/* [foreground token, background token, minimum, description] */
const PAIRS = [
  ["--ink", "--surface", 4.5, "body text on paper"],
  ["--ink", "--surface-2", 4.5, "body text on panels"],
  ["--ink", "--surface-3", 4.5, "body text on the deepest tint"],
  ["--ink", "--today", 4.5, "body text on today's cell"],
  ["--ink-2", "--surface", 4.5, "muted text on paper"],
  ["--ink-2", "--surface-2", 4.5, "muted text on panels"],
  ["--ink-2", "--surface-3", 4.5, "muted text on the deepest tint"],
  ["--bar-ink", "--bar", 4.5, "wordmark on the app bar"],
  ["--bar-ink-2", "--bar", 4.5, "inactive view switch on the app bar"],
  ["--signature", "--bar", 4.5, "signature on the app bar"],
  ["--accent-ink", "--accent", 4.5, "primary button label"],
  ["--accent-ink", "--accent-hover", 4.5, "primary button label, hovered"],
  ["--accent", "--surface", 4.5, "accent text on paper"],
  ["--ink", "--accent-soft", 4.5, "update bar text"],
  ["--danger", "--surface", 4.5, "error text on paper"],
  ["--danger", "--surface-2", 4.5, "error text on panels"],
  ["--t-test-ink", "--t-test", 4.5, "test chip label"],
  ["--t-homework-ink", "--t-homework", 4.5, "homework chip label"],
  ["--t-project-ink", "--t-project", 4.5, "project chip label"],
  ["--t-other-ink", "--t-other", 4.5, "other chip label"],
  ["--done-ink", "--done", 4.5, "completed chip label"],
  ["--t-test", "--surface", 3, "test glyph and border on paper"],
  ["--t-homework", "--surface", 3, "homework glyph and border on paper"],
  ["--t-project", "--surface", 3, "project glyph and border on paper"],
  ["--t-other", "--surface", 3, "other glyph and border on paper"],
  ["--t-test", "--surface-2", 3, "test glyph on panels"],
  ["--t-homework", "--surface-2", 3, "homework glyph on panels"],
  ["--t-project", "--surface-2", 3, "project glyph on panels"],
  ["--t-other", "--surface-2", 3, "other glyph on panels"],
  ["--line-strong", "--surface", 3, "input borders on paper"],
  ["--line-strong", "--surface-2", 3, "input borders on panels"],
  ["--line-strong", "--surface-3", 3, "input borders on the deepest tint"],
  ["--focus", "--surface", 3, "focus ring on paper"],
  ["--focus", "--surface-2", 3, "focus ring on panels"],
  ["--today-line", "--surface", 3, "today outline on paper"],
];

let failures = 0;

for (const [themeName, theme] of [["light", light], ["dark", dark]]) {
  console.log(`\n${themeName} theme`);
  for (const [fg, bg, min, label] of PAIRS) {
    const fgValue = theme[fg];
    const bgValue = theme[bg];
    if (!fgValue || !bgValue) {
      console.log(`  ?  ${label}: missing ${fgValue ? bg : fg}`);
      failures += 1;
      continue;
    }
    const value = ratio(fgValue, bgValue);
    const ok = value >= min;
    if (!ok) failures += 1;
    console.log(
      `  ${ok ? "ok " : "NO "} ${value.toFixed(2)}:1 (needs ${min}:1)  ${label}  [${fgValue} on ${bgValue}]`
    );
  }
}

console.log(failures === 0 ? "\nAll pairs pass.\n" : `\n${failures} pair(s) below target.\n`);
process.exit(failures === 0 ? 0 : 1);
