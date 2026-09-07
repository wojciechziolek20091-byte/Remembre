/*
  Bundles the site into one self-contained HTML file with the stylesheet, the
  script and both typefaces inlined as data URIs, so it runs from a double
  click with no server and no network.

  Run with:  npm run build
  Writes dist/remembre.html, and dist/remembre.body.html -- the same page
  without the document scaffolding, for hosts that supply their own.
*/

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(join(root, name), "utf8");

const css = read("styles.css").replace(
  /url\("fonts\/([^"]+)"\)/g,
  (_, file) => `url(data:font/woff2;base64,${readFileSync(join(root, "fonts", file)).toString("base64")})`
);

const js = read("app.js");
const html = read("index.html");

const body = html
  .slice(html.indexOf("<body>") + "<body>".length, html.lastIndexOf("</body>"))
  .replace(/^\s*<script src="app\.js"><\/script>\s*$/m, "")
  .trim();

const title = html.match(/<title>([^<]*)<\/title>/)[1];
const description = html.match(/<meta name="description" content="([^"]*)"/)[1];
const favicon = readFileSync(join(root, "favicon.svg")).toString("base64");

const inlined = `<title>${title}</title>\n<style>\n${css}\n</style>\n\n${body}\n\n<script>\n${js}\n</script>\n`;

const standalone = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="description" content="${description}">
<meta name="theme-color" content="#33505C">
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${favicon}">
${inlined}</head>
</html>
`.replace("</head>\n</html>", "").replace(/^<title>/m, "<title>");

// Keep the document well-formed: everything above <body> stays in <head>.
const head = standalone.slice(0, standalone.indexOf("<title>"));
const rest = standalone.slice(standalone.indexOf("<title>"));
const styleEnd = rest.indexOf("</style>") + "</style>".length;
const final = `${head}${rest.slice(0, styleEnd)}\n</head>\n<body>\n${rest.slice(styleEnd).trim()}\n</body>\n</html>\n`;

mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist", "remembre.html"), final);
writeFileSync(join(root, "dist", "remembre.body.html"), inlined);

const kb = (s) => `${Math.round(Buffer.byteLength(s) / 1024)} KB`;
console.log(`dist/remembre.html       ${kb(final)}  (standalone, opens from a double click)`);
console.log(`dist/remembre.body.html  ${kb(inlined)}  (no document scaffolding)`);
