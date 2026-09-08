/*
  Exercises the sync server without deploying it. The handlers are plain Node
  request/response functions, so a small http server in front of them is the
  whole harness; the store is a temporary directory.

  Run: node tools/api-test.mjs
*/

import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "remembre-api-"));
process.env.REMEMBRE_DATA_DIR = dir;
delete process.env.KV_REST_API_URL;
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.REMEMBRE_GITHUB_TOKEN;

const [{ default: sync }, { default: calendar }, { default: status }] = await Promise.all([
  import("../api/sync.js"),
  import("../api/calendar.js"),
  import("../api/status.js"),
]);

const routes = { "/api/sync": sync, "/api/calendar": calendar, "/api/status": status };

const server = createServer((req, res) => {
  const path = req.url.split("?")[0];
  const handler = routes[path];
  if (!handler) {
    res.statusCode = 404;
    return res.end("no route");
  }
  Promise.resolve(handler(req, res)).catch((err) => {
    console.error(err);
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.end("threw");
    }
  });
});

await new Promise((resolve) => server.listen(0, resolve));
const base = `http://127.0.0.1:${server.address().port}`;

let passed = 0;
const failures = [];

function check(label, condition, detail = "") {
  if (condition) passed += 1;
  else failures.push(detail ? `${label} -- ${detail}` : label);
}

const CODE = "quiet-cherry-mornings";
const at = (minutes) => new Date(Date.UTC(2026, 8, 8, 9, minutes)).toISOString();

const task = (id, title, updatedAt, extra = {}) => ({
  id, title, updatedAt, type: "homework", subject: "history",
  date: "2026-09-20", time: "", done: false, ...extra,
});

const ICS = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Remembre//EN",
  "BEGIN:VEVENT", "UID:one@remembre.app", "SUMMARY:Homework: Essay",
  "DTSTART;VALUE=DATE:20260920", "END:VEVENT", "END:VCALENDAR", "",
].join("\r\n");

const post = (body) => fetch(`${base}/api/sync`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/* ---------- Which store is live ---------- */

{
  const res = await fetch(`${base}/api/status`);
  const body = await res.json();
  check("status answers 200", res.status === 200, `got ${res.status}`);
  check("status reports a store is configured", body.configured === true);
  check("status picks the on-disk driver", body.using === "files", `got ${body.using}`);
  check("status lists every driver", body.drivers.length === 4, `got ${body.drivers.length}`);
  check(
    "status names the variables it can see",
    body.seen.includes("REMEMBRE_DATA_DIR"),
    JSON.stringify(body.seen),
  );
  check("status says what each driver would need", typeof body.drivers[0].needs === "string");
  check(
    "status never reports a secret's value",
    !JSON.stringify(body).includes(dir),
  );
}

/* ---------- The same credential under any prefix ---------- */

{
  /*
    A Redis store attached through Vercel's marketplace names its variables
    after a prefix chosen when it was connected, so the same URL arrives as
    KV_REST_API_URL, UPSTASH_REDIS_REST_URL or STORAGE_REST_API_URL depending
    on nothing the app can predict. All of them have to be recognised, or a
    correctly attached store reads as no store at all.
  */
  const { storeReport } = await import("../api/_store.js");
  delete process.env.REMEMBRE_DATA_DIR;

  const prefixes = [
    ["KV_REST_API_URL", "KV_REST_API_TOKEN", "Vercel's own"],
    ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "Upstash's own"],
    ["STORAGE_REST_API_URL", "STORAGE_REST_API_TOKEN", "a STORAGE prefix"],
    ["REMEMBRE_KV_REST_API_URL", "REMEMBRE_KV_REST_API_TOKEN", "a prefix nobody could guess"],
  ];

  for (const [urlName, tokenName, description] of prefixes) {
    process.env[urlName] = "https://example.upstash.io";
    process.env[tokenName] = "not-a-real-token";
    const report = storeReport();
    check(`a store named with ${description} is found`, report.using === "redis", report.using);
    check(
      `and status says which two variables it used (${description})`,
      report.matched.join(",") === `${urlName},${tokenName}`,
      report.matched.join(","),
    );
    check(`and names it among what it can see (${description})`, report.seen.includes(urlName));
    check(
      `without ever reporting the token (${description})`,
      !JSON.stringify(report).includes("not-a-real-token"),
    );
    delete process.env[urlName];
    delete process.env[tokenName];
  }

  // The TCP endpoint is not the REST one and cannot be used from a function.
  process.env.STORAGE_URL = "rediss://default:secret@example.upstash.io:6379";
  check("a rediss:// URL alone is not mistaken for a REST endpoint", storeReport().configured === false);
  delete process.env.STORAGE_URL;

  // A URL with no matching token is not half a store.
  process.env.STORAGE_REST_API_URL = "https://example.upstash.io";
  check("a URL with no token is not enough", storeReport().configured === false);
  check("but it is still reported as seen", storeReport().seen.includes("STORAGE_REST_API_URL"));
  delete process.env.STORAGE_REST_API_URL;

  process.env.REMEMBRE_DATA_DIR = dir;
}

/* ---------- A phrase has to be worth guessing ---------- */

for (const bad of ["", "short", "elevenchars"]) {
  const res = await fetch(`${base}/api/sync?code=${encodeURIComponent(bad)}`);
  check(`a ${bad.length}-character phrase is refused`, res.status === 400, `got ${res.status}`);
}

/* ---------- Nothing stored yet ---------- */

{
  const res = await fetch(`${base}/api/sync?code=${encodeURIComponent(CODE)}`);
  const body = await res.json();
  check("an unknown phrase answers 200", res.status === 200, `got ${res.status}`);
  check("an unknown phrase found nothing", body.found === false);
  check("an unknown phrase still returns empty collections", Array.isArray(body.vault.tasks) && body.vault.tasks.length === 0);
  check("a feed token comes back regardless", /^[a-f0-9]{32}$/.test(body.feed), body.feed);
}

/* ---------- The first device pushes ---------- */

let feed = "";
{
  const res = await post({ code: CODE, ics: ICS, vault: { tasks: [task("a", "Essay", at(0))] } });
  const body = await res.json();
  check("a push answers 200", res.status === 200, `got ${res.status}`);
  check("the push reports what it added", body.changed.tasks === 1, JSON.stringify(body.changed));
  check("the pushed task comes back", body.vault.tasks.length === 1);
  feed = body.feed;
  check("the feed token is stable", /^[a-f0-9]{32}$/.test(feed));
}

/* ---------- The second device reads it ---------- */

{
  const res = await fetch(`${base}/api/sync?code=${encodeURIComponent(CODE)}`);
  const body = await res.json();
  check("the second device finds the vault", body.found === true);
  check("the second device sees the task", body.vault.tasks[0].title === "Essay");
  check("both devices derive the same feed", body.feed === feed);
}

/* ---------- Merging, not overwriting ---------- */

{
  // The second device has been offline and knows nothing about "a". A plain
  // overwrite would lose it.
  await post({ code: CODE, vault: { tasks: [task("b", "Reading", at(1))] } });
  const res = await fetch(`${base}/api/sync?code=${encodeURIComponent(CODE)}`);
  const body = await res.json();
  const ids = body.vault.tasks.map((t) => t.id).sort();
  check("a stale device does not wipe the other one's work", ids.join(",") === "a,b", ids.join(","));
}

{
  // Same record, older edit: the newer updatedAt has to survive.
  await post({ code: CODE, vault: { tasks: [task("a", "Essay, second draft", at(5))] } });
  await post({ code: CODE, vault: { tasks: [task("a", "Essay, stale", at(2))] } });
  const res = await fetch(`${base}/api/sync?code=${encodeURIComponent(CODE)}`);
  const body = await res.json();
  const kept = body.vault.tasks.find((t) => t.id === "a");
  check("the newer edit of a record wins", kept.title === "Essay, second draft", kept.title);
}

{
  // A tombstone is a record like any other, so a delete has to survive the
  // next push from a device that still holds the task.
  await post({ code: CODE, vault: { tasks: [task("b", "Reading", at(9), { deleted: true })] } });
  await post({ code: CODE, vault: { tasks: [task("b", "Reading", at(1))] } });
  const res = await fetch(`${base}/api/sync?code=${encodeURIComponent(CODE)}`);
  const body = await res.json();
  const gone = body.vault.tasks.find((t) => t.id === "b");
  check("a delete is not undone by a stale device", gone.deleted === true);
}

{
  const res = await post({ code: CODE, vault: { tasks: [task("a", "Essay, second draft", at(5))] } });
  const body = await res.json();
  check("pushing the same copy twice changes nothing", body.changed.tasks === 0, JSON.stringify(body.changed));
}

/* ---------- Coursework and sessions travel too ---------- */

{
  await post({
    code: CODE,
    vault: {
      coursework: [{ id: "c1", title: "Extended essay", updatedAt: at(3) }],
      sessions: [{ id: "s1", date: "2026-09-14", updatedAt: at(3) }],
    },
  });
  const res = await fetch(`${base}/api/sync?code=${encodeURIComponent(CODE)}`);
  const body = await res.json();
  check("coursework syncs", body.vault.coursework.length === 1);
  check("study sessions sync", body.vault.sessions.length === 1);
  check("pushing one collection leaves the others alone", body.vault.tasks.length === 2);
}

/* ---------- The calendar subscription ---------- */

{
  const res = await fetch(`${base}/api/calendar?feed=${feed}`);
  const text = await res.text();
  check("the feed answers 200", res.status === 200, `got ${res.status}`);
  check("the feed is served as a calendar", (res.headers.get("content-type") || "").startsWith("text/calendar"));
  check("the feed carries the pushed calendar", text.includes("SUMMARY:Homework: Essay"));
  check("the feed is cacheable but not for long", /max-age=300/.test(res.headers.get("cache-control") || ""));
}

{
  // A push without an .ics must not blank an existing subscription.
  const res = await fetch(`${base}/api/calendar?feed=${feed}`);
  check("a push with no calendar leaves the feed standing", (await res.text()).includes("BEGIN:VEVENT"));
}

{
  const res = await fetch(`${base}/api/calendar?feed=${"0".repeat(32)}`);
  const text = await res.text();
  check("an unknown feed answers 200, not 404", res.status === 200, `got ${res.status}`);
  check("an unknown feed is an empty calendar", text.includes("BEGIN:VCALENDAR") && !text.includes("BEGIN:VEVENT"));
}

{
  const res = await fetch(`${base}/api/calendar?feed=not-a-token`);
  check("a malformed feed address is refused", res.status === 400, `got ${res.status}`);
}

/* ---------- The phrase itself never becomes an address ---------- */

{
  const { feedToken, vaultKey } = await import("../api/_store.js");
  check("the feed token is not the phrase", !feedToken(CODE).includes(CODE));
  check("the vault key is not the phrase", !vaultKey(CODE).includes(CODE));
  check(
    "the feed token cannot be walked back to the vault key",
    !vaultKey(CODE).includes(feedToken(CODE)),
  );
  check("a different phrase is a different vault", vaultKey(CODE) !== vaultKey(`${CODE}!`));
}

/* ---------- No store at all ---------- */

{
  delete process.env.REMEMBRE_DATA_DIR;
  const res = await fetch(`${base}/api/sync?code=${encodeURIComponent(CODE)}`);
  const body = await res.json();
  check("with no store, sync says so rather than failing", res.status === 503, `got ${res.status}`);
  check("with no store, the reason is readable", /storage/i.test(body.message || ""));

  const statusRes = await fetch(`${base}/api/status`);
  const statusBody = await statusRes.json();
  check("with no store, status still answers", statusRes.status === 200);
  check("with no store, status admits it", statusBody.configured === false);
  process.env.REMEMBRE_DATA_DIR = dir;
}

/* ---------- Done ---------- */

server.close();
await rm(dir, { recursive: true, force: true });

if (failures.length) {
  console.error(`\n${failures.length} failed:\n` + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log(`api-test: ${passed}/${passed} checks passed`);
