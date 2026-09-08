/*
  The nightly run, end to end, with a fake push service standing in for Apple's.

  The fake service is a real HTTP server: it receives exactly what the real one
  would, decrypts the payload with the device's own keys, and can be told to
  answer 410 the way a push service does when a device is gone. So this checks
  the parts that only show up in the whole: that the right thing is sent, at the
  right time in the device's own zone, once and only once a day, and that a dead
  device is forgotten instead of retried forever.

  Run: node tools/notify-test.mjs
*/

import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decrypt, makeDevice } from "./_push-receiver.mjs";

const dir = await mkdtemp(join(tmpdir(), "remembre-notify-"));
process.env.REMEMBRE_DATA_DIR = dir;
delete process.env.KV_REST_API_URL;
delete process.env.CRON_SECRET;

const { generateVapidKeys, saveSubscription, listSubscriptions, subscriptionId } =
  await import("../api/_push.js");
const fresh = generateVapidKeys();
process.env.VAPID_PUBLIC_KEY = fresh.publicKey;
process.env.VAPID_PRIVATE_KEY = fresh.privateKey;
process.env.VAPID_SUBJECT = "mailto:tests@example.com";

const { default: notify, digest, localClock } = await import("../api/notify.js");
const { default: subscribeRoute } = await import("../api/subscribe.js");
const { store, vaultKey } = await import("../api/_store.js");

let passed = 0;
const failures = [];
const check = (label, ok, detail = "") => {
  if (ok) passed += 1;
  else failures.push(detail ? `${label} -- ${detail}` : label);
  console.log(`  ${ok ? "ok " : "NO "} ${label}`);
};

/* ---------- A push service that is not really Apple ---------- */

const delivered = [];
let answerWith = 201;

const pushService = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    delivered.push({
      path: req.url,
      authorization: req.headers.authorization || "",
      encoding: req.headers["content-encoding"] || "",
      ttl: req.headers.ttl || "",
      body: Buffer.concat(chunks),
    });
    res.statusCode = answerWith;
    res.end(answerWith === 410 ? "gone" : "");
  });
});
await new Promise((resolve) => pushService.listen(0, "127.0.0.1", resolve));
const pushBase = `http://127.0.0.1:${pushService.address().port}`;

/* ---------- Calling the routes without a network in between ---------- */

function call(handler, { method = "GET", url = "/", body = null, headers = {} } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      end(payload) {
        if (payload) chunks.push(Buffer.from(payload));
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try { parsed = JSON.parse(text); } catch (err) { parsed = null; }
        resolve({ status: this.statusCode, body: parsed, text });
      },
    };
    const req = { method, url, headers, body };
    Promise.resolve(handler(req, res)).catch((err) => resolve({ status: 500, body: null, text: String(err) }));
  });
}

const CODE = "quiet-cherry-mornings";
const live = store();

async function putVault(vault) {
  await live.put(vaultKey(CODE), JSON.stringify(vault));
}

/* ---------- What time is it where the reader is? ---------- */

console.log("\nreading the device's own clock");

{
  // A fixed instant: 15:30 UTC on 8 September 2026.
  const instant = new Date("2026-09-08T15:30:00Z");

  const warsaw = localClock("Europe/Warsaw", instant);
  check("a summer evening in Warsaw is 17:30", warsaw.time === "17:30", warsaw.time);
  check("and it is past the reminder hour", warsaw.hour === 17, String(warsaw.hour));
  check("tomorrow is the 9th", warsaw.tomorrow === "2026-09-09", warsaw.tomorrow);

  const utc = localClock("UTC", instant);
  check("the same instant is 15:30 in UTC", utc.time === "15:30", utc.time);
  check("and not yet the reminder hour there", utc.hour < 17);

  const winter = localClock("Europe/Warsaw", new Date("2026-12-08T16:30:00Z"));
  check("a winter evening reads an hour differently", winter.time === "17:30", winter.time);

  const across = localClock("Europe/Warsaw", new Date("2026-09-08T22:30:00Z"));
  check("past local midnight, today has already moved on", across.today === "2026-09-09", across.today);
  check("and so has tomorrow", across.tomorrow === "2026-09-10", across.tomorrow);

  const nonsense = localClock("Not/AZone", instant);
  check("an unknown zone falls back to UTC rather than throwing", nonsense.time === "15:30", nonsense.time);

  const month = localClock("UTC", new Date("2026-09-30T18:00:00Z"));
  check("tomorrow crosses a month end correctly", month.tomorrow === "2026-10-01", month.tomorrow);
  const year = localClock("UTC", new Date("2026-12-31T18:00:00Z"));
  check("and a year end", year.tomorrow === "2027-01-01", year.tomorrow);
}

/* ---------- What goes in the notification ---------- */

console.log("\nwhat it says");

{
  const task = (title, extra = {}) => ({ id: title, title, date: "2026-09-09", type: "homework", ...extra });

  check("nothing due means nothing sent", digest({ tasks: [], coursework: [], sessions: [] }, "2026-09-09") === null);
  check(
    "a completed task is not worth an interruption",
    digest({ tasks: [task("Done already", { done: true })] }, "2026-09-09") === null,
  );
  check(
    "and neither is a deleted one",
    digest({ tasks: [task("Gone", { deleted: true })] }, "2026-09-09") === null,
  );
  check(
    "a task for another day is left alone",
    digest({ tasks: [{ ...task("Later"), date: "2026-09-20" }] }, "2026-09-09") === null,
  );

  const one = digest({ tasks: [task("Cold War essay")] }, "2026-09-09");
  check("one task is named", one.body === "Cold War essay", one.body);
  check("and the title says what it is about", one.title === "Remember, for tomorrow", one.title);
  check("and it is tagged by date so it cannot stack", one.tag === "remembre-2026-09-09", one.tag);

  const test = digest({ tasks: [task("Chapters 3-5", { type: "test" })] }, "2026-09-09");
  check("a test is marked as one", test.body === "Chapters 3-5 (test)", test.body);

  const many = digest({ tasks: ["a", "b", "c", "d", "e"].map((t) => task(t)) }, "2026-09-09");
  check("a long list names three and counts the rest", many.body === "a, b, c, and 2 more", many.body);

  const mixed = digest({
    tasks: [task("Reading")],
    coursework: [{ id: "c", title: "Extended essay", due: "2026-09-09", stage: "drafting" }],
    sessions: [{ id: "s", date: "2026-09-09" }],
  }, "2026-09-09");
  check("coursework and sessions come along", mixed.body === "Reading, Extended essay due · 1 study session", mixed.body);

  const submitted = digest({
    coursework: [{ id: "c", title: "Handed in", due: "2026-09-09", stage: "submitted" }],
  }, "2026-09-09");
  check("something already submitted is not a reminder", submitted === null);

  const study = digest({ sessions: [{ id: "s", date: "2026-09-09" }, { id: "t", date: "2026-09-09" }] }, "2026-09-09");
  check("a day of only study sessions says so", study.title === "Study time tomorrow", study.title);
  check("and counts them", study.body === "2 study sessions", study.body);
}

/* ---------- Registering a device ---------- */

console.log("\nregistering a device");

{
  const device = makeDevice("https://web.push.apple.com/real-looking-device");
  const res = await call(subscribeRoute, {
    method: "POST", url: "/api/subscribe",
    body: { code: CODE, subscription: device.browserShape, zone: "Europe/Warsaw" },
  });
  check("a device can register", res.status === 200 && res.body.subscribed === true, res.text);
  check("and is identified by its endpoint", res.body.device === subscriptionId(device.endpoint));

  const held = await listSubscriptions(live);
  check("the server keeps it", held.length === 1);
  check("filed against the vault, not the phrase", held[0].vault === vaultKey(CODE));
  check("and never stores the phrase itself", !JSON.stringify(held[0]).includes(CODE));
  check("with the device's time zone", held[0].zone === "Europe/Warsaw");

  const again = await call(subscribeRoute, {
    method: "POST", url: "/api/subscribe",
    body: { code: CODE, subscription: device.browserShape, zone: "Europe/Warsaw" },
  });
  check("registering twice does not make two devices", again.status === 200 && (await listSubscriptions(live)).length === 1);

  const short = await call(subscribeRoute, {
    method: "POST", url: "/api/subscribe", body: { code: "tooshort", subscription: device.browserShape },
  });
  check("a short phrase is refused", short.status === 400, short.text);

  const notAnEndpoint = await call(subscribeRoute, {
    method: "POST", url: "/api/subscribe",
    body: { code: CODE, subscription: { endpoint: "http://insecure.example/x", keys: device.browserShape.keys } },
  });
  check("an endpoint that is not https is refused", notAnEndpoint.status === 400, notAnEndpoint.text);

  const noKeys = await call(subscribeRoute, {
    method: "POST", url: "/api/subscribe",
    body: { code: CODE, subscription: { endpoint: "https://push.example/x" } },
  });
  check("a subscription with no keys is refused", noKeys.status === 400, noKeys.text);

  const gone = await call(subscribeRoute, {
    method: "DELETE", url: "/api/subscribe",
    body: { code: CODE, subscription: device.browserShape },
  });
  check("and a device can be forgotten", gone.status === 200 && (await listSubscriptions(live)).length === 0);
}

/* ---------- The run itself ---------- */

console.log("\nthe nightly run");

// Registered directly, because the endpoint has to be this test's own server
// and /api/subscribe rightly insists on https for a real one.
const device = makeDevice(`${pushBase}/device-one`);
const register = async (zone, extra = {}) => {
  await saveSubscription(live, subscriptionId(device.endpoint), {
    vault: vaultKey(CODE),
    endpoint: device.endpoint,
    p256dh: device.p256dh,
    auth: device.auth,
    zone,
    lastSentFor: "",
    ...extra,
  });
};

await putVault({
  tasks: [
    { id: "t1", title: "Economics practice paper", date: tomorrowIn("Europe/Warsaw"), type: "homework", updatedAt: "2026-01-01" },
  ],
  coursework: [],
  sessions: [],
});

function tomorrowIn(zone) {
  return localClock(zone).tomorrow;
}

{
  // Somewhere it is still the middle of the afternoon.
  await register("Pacific/Honolulu");
  const res = await call(notify, { url: "/api/notify" });
  const only = res.body.report[0];
  const early = only.why === "too early where this device is";
  check(
    "a device where it is not yet evening is left alone",
    early || only.sent === false,
    JSON.stringify(only),
  );
  if (!early) console.log(`      (it is ${only.at} in Honolulu, so this ran after 17:00 there)`);
}

{
  // A zone where it is certainly past 17:00, whatever time this test runs.
  const zone = zoneWhereItIsEvening();
  await register(zone);
  delivered.length = 0;
  const res = await call(notify, { url: "/api/notify" });
  const only = res.body.report[0];
  check("a device where it is evening is sent to", only.sent === true, JSON.stringify(only));
  check("exactly one notification goes out", delivered.length === 1, String(delivered.length));

  const sent = delivered[0];
  check("it went to that device's endpoint", sent.path === "/device-one", sent.path);
  check("it is signed", /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/.test(sent.authorization), sent.authorization.slice(0, 40));
  check("and encrypted the way the browser expects", sent.encoding === "aes128gcm", sent.encoding);
  check("with a time to live, so a phone that is off still gets it", Number(sent.ttl) > 0, sent.ttl);

  const opened = JSON.parse(decrypt(device, sent.body).text);
  check("the device can read it", opened.body === "Economics practice paper", opened.body);
  check("and it is about tomorrow", opened.date === tomorrowIn(zone), opened.date);
}

{
  delivered.length = 0;
  const res = await call(notify, { url: "/api/notify" });
  check("running it again the same day sends nothing", delivered.length === 0, String(delivered.length));
  check("and says why", res.body.report[0].why === "already told about tomorrow", JSON.stringify(res.body.report[0]));
}

{
  await register(zoneWhereItIsEvening());
  await putVault({ tasks: [], coursework: [], sessions: [] });
  delivered.length = 0;
  const res = await call(notify, { url: "/api/notify" });
  check("an empty day is not worth a notification", delivered.length === 0);
  check("and it says so", res.body.report[0].why === "nothing due tomorrow", JSON.stringify(res.body.report[0]));
}

{
  await register(zoneWhereItIsEvening());
  await putVault({ tasks: [{ id: "t1", title: "Reading", date: tomorrowIn(zoneWhereItIsEvening()), type: "homework" }] });
  delivered.length = 0;
  const res = await call(notify, { url: "/api/notify?dry=1" });
  check("a dry run sends nothing", delivered.length === 0);
  check("but says what it would have sent", res.body.report[0].would === "Reading", JSON.stringify(res.body.report[0]));
  check("and nothing is marked as done", (await listSubscriptions(live))[0].lastSentFor === "");
}

{
  // A device that has been wiped: the push service says so, once.
  answerWith = 410;
  await register(zoneWhereItIsEvening());
  const res = await call(notify, { url: "/api/notify" });
  check("a device that is gone is forgotten", res.body.report[0].why.includes("gone"), JSON.stringify(res.body.report[0]));
  check("and is not tried again", (await listSubscriptions(live)).length === 0);
  answerWith = 201;
}

/* ---------- Who may set it running ---------- */

console.log("\nwho may set it running");

{
  process.env.CRON_SECRET = "a-shared-secret";
  await register(zoneWhereItIsEvening());
  delivered.length = 0;

  const stranger = await call(notify, { url: "/api/notify" });
  check("without the secret, nothing is sent", delivered.length === 0);
  check("and it is treated as a dry run rather than an error", stranger.body.dryRun === true);

  const scheduler = await call(notify, {
    url: "/api/notify", headers: { authorization: "Bearer a-shared-secret" },
  });
  check("with the secret, it sends", delivered.length === 1 && scheduler.body.dryRun === false, String(delivered.length));
  delete process.env.CRON_SECRET;
}

/* ---------- A zone where the evening has already arrived ---------- */

function zoneWhereItIsEvening() {
  const candidates = [
    "Pacific/Kiritimati", "Pacific/Auckland", "Australia/Sydney", "Asia/Tokyo",
    "Asia/Kolkata", "Europe/Warsaw", "UTC", "America/New_York", "America/Los_Angeles",
    "Pacific/Honolulu",
  ];
  // 17:00 through 22:00 leaves room for the run to take a moment without the
  // local date rolling over underneath it.
  const found = candidates.find((zone) => {
    const hour = localClock(zone).hour;
    return hour >= 17 && hour <= 22;
  });
  if (!found) throw new Error("no candidate zone is in its evening right now");
  return found;
}

/* ---------- Done ---------- */

pushService.close();
await rm(dir, { recursive: true, force: true });

if (failures.length) {
  console.error(`\n${failures.length} failed:\n` + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log(`\nnotify-test: ${passed}/${passed} checks passed`);
