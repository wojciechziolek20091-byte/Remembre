import { cors, json, notConfigured, store } from "./_store.js";
import { forgetSubscription, listSubscriptions, saveSubscription, sendPush, vapidKeys } from "./_push.js";

/**
 * The run that sends notifications to devices that are not running the app.
 *
 * It decides nothing from its own clock. The server's is UTC and "the evening
 * before" and "an hour before your session" are questions about the reader's
 * wall clock, so every judgement here is made in each device's own zone.
 *
 * Nothing here assumes it runs on time, or even that it runs once. A reminder
 * is sent when its moment has passed, has not passed by more than an hour and a
 * half, and has not already been sent to that device -- so a scheduler that is
 * late, early, or fires five times in a minute all produce the same result.
 * That is what lets a caller with no fine-grained scheduler stand in for one by
 * calling often.
 */

const REMINDER_HOUR = 17;        // "Remember this" the evening before.
const SESSION_LEAD_MINUTES = 60; // "In an hour" before a study session.
const WINDOW_MINUTES = 90;       // How late a reminder may be and still be worth sending.
const KEEP_DAYS = 3;             // How long to remember what was already sent.

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "GET" && req.method !== "POST") {
    return json(res, 405, { error: "method-not-allowed" });
  }

  // Vercel signs its own scheduled calls, and so can anything else that has
  // been told the secret. Without it a caller may still ask what would happen.
  const secret = process.env.CRON_SECRET;
  const offered = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const url = new URL(req.url, "http://localhost");
  const dryRun = url.searchParams.get("dry") === "1" || (secret && offered !== secret);

  const live = store();
  if (!live) return notConfigured(res);
  if (!vapidKeys()) {
    return json(res, 503, { error: "no-keys", message: "No VAPID keys are set, so nothing can be sent." });
  }

  try {
    const devices = await listSubscriptions(live);
    const vaults = new Map();
    const report = [];
    let sentCount = 0;

    for (const device of devices) {
      const clock = localClock(device.zone);
      if (!vaults.has(device.vault)) vaults.set(device.vault, await readVault(live, device.vault));
      const vault = vaults.get(device.vault);

      const sent = typeof device.sent === "object" && device.sent ? { ...device.sent } : migrate(device);
      const waiting = dueReminders(vault, clock).filter((item) => !sent[item.key]);

      if (waiting.length === 0) {
        report.push({ device: device.id, zone: device.zone, at: clock.time, sent: 0 });
        continue;
      }
      if (dryRun) {
        report.push({
          device: device.id, zone: device.zone, at: clock.time, sent: 0,
          would: waiting.map((item) => item.body),
        });
        continue;
      }

      const delivered = [];
      let gone = false;
      for (const item of waiting) {
        const result = await sendPush(device, JSON.stringify(item.message));
        if (result.gone) { gone = true; break; }
        if (!result.ok) {
          report.push({ device: device.id, failed: `push service said ${result.status}`, detail: result.detail });
          break;
        }
        sent[item.key] = clock.today;
        delivered.push(item.body);
        sentCount += 1;
      }

      if (gone) {
        await forgetSubscription(live, device.id);
        report.push({ device: device.id, sent: 0, why: "this device is gone; forgotten" });
        continue;
      }

      await saveSubscription(live, device.id, { ...device, sent: prune(sent, clock.today), lastSentFor: undefined });
      report.push({ device: device.id, zone: device.zone, at: clock.time, sent: delivered.length, delivered });
    }

    return json(res, 200, { ok: true, dryRun: Boolean(dryRun), devices: devices.length, sent: sentCount, report });
  } catch (err) {
    console.error("notify failed:", err);
    return json(res, 502, { error: "failed", message: String(err && err.message) });
  }
}

/* ---------- What time is it where the reader is? ---------- */

/**
 * The device's own wall clock. Built from the zone name rather than a stored
 * offset, so it stays right across a daylight-saving change without the device
 * having to check in and say so.
 */
export function localClock(zone, now = new Date()) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone || "UTC",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(now);
  } catch (err) {
    return localClock("UTC", now);
  }

  const at = {};
  parts.forEach((part) => { at[part.type] = part.value; });
  const hour = Number(at.hour) % 24;
  const minute = Number(at.minute);
  const today = `${at.year}-${at.month}-${at.day}`;

  return {
    hour,
    minute,
    minutes: hour * 60 + minute,
    today,
    tomorrow: addDays(today, 1),
    time: `${String(hour).padStart(2, "0")}:${at.minute}`,
  };
}

/** Adding a day to a plain date, without letting a time zone near it. */
function addDays(date, days) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/* ---------- What is there to say? ---------- */

async function readVault(live, key) {
  const empty = { tasks: [], coursework: [], sessions: [] };
  const raw = await live.get(key);
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : empty;
  } catch (err) {
    return empty;
  }
}

const alive = (list) => (Array.isArray(list) ? list : []).filter((r) => r && !r.deleted);

/**
 * Everything this device should have been told by now and has not been. A
 * moment that passed more than WINDOW_MINUTES ago is left alone: a reminder for
 * a session that started this morning is worse than no reminder at all.
 */
export function dueReminders(vault, clock) {
  const due = [];

  const digestMessage = digest(vault, clock.tomorrow);
  if (clock.hour >= REMINDER_HOUR && digestMessage) {
    due.push({ key: `digest:${clock.tomorrow}`, body: digestMessage.body, message: digestMessage });
  }

  const named = new Map(alive(vault.coursework).map((item) => [item.id, item.title]));

  alive(vault.sessions)
    .filter((session) => !session.done && session.date === clock.today)
    .forEach((session) => {
      const at = minutesOf(session.time);
      if (at === null) return;
      const name = named.get(session.courseworkId) || "your coursework";

      const moments = [
        { key: `session-soon:${session.id}`, at: at - SESSION_LEAD_MINUTES, title: "In an hour", body: `${name} · ${session.minutes} minutes` },
        { key: `session-now:${session.id}`, at, title: "Time to study", body: `${name} · ${session.minutes} minutes` },
      ];

      moments.forEach((moment) => {
        const late = clock.minutes - moment.at;
        if (late < 0 || late > WINDOW_MINUTES) return;
        due.push({
          key: moment.key,
          body: `${moment.title}: ${moment.body}`,
          message: { title: moment.title, body: moment.body, date: clock.today, tag: moment.key },
        });
      });
    });

  return due;
}

const minutesOf = (time) => {
  const match = /^(\d{2}):(\d{2})$/.exec(String(time || ""));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

/**
 * The evening's summary, or null when there is nothing worth interrupting
 * anybody for. Named things read better than a count, so up to three are listed
 * and the rest are summed.
 */
export function digest(vault, date) {
  const tasks = alive(vault.tasks).filter((t) => !t.done && t.date === date);
  const coursework = alive(vault.coursework).filter((c) => c.stage !== "submitted" && c.due === date);
  const sessions = alive(vault.sessions).filter((s) => !s.done && s.date === date);

  const items = [
    ...tasks.map((t) => (t.type === "test" ? `${t.title} (test)` : t.title)),
    ...coursework.map((c) => `${c.title} due`),
  ];
  if (items.length === 0 && sessions.length === 0) return null;

  const named = items.slice(0, 3);
  const rest = items.length - named.length;
  const pieces = [];
  if (named.length) pieces.push(named.join(", ") + (rest > 0 ? `, and ${rest} more` : ""));
  if (sessions.length) pieces.push(`${sessions.length} study ${sessions.length === 1 ? "session" : "sessions"}`);

  return {
    title: items.length ? "Remember, for tomorrow" : "Study time tomorrow",
    body: pieces.join(" · "),
    date,
    tag: `remembre-${date}`,
  };
}

/* ---------- Remembering what has been said ---------- */

/** Devices registered before this file kept one date; carry it across. */
function migrate(device) {
  return device.lastSentFor ? { [`digest:${device.lastSentFor}`]: device.lastSentFor } : {};
}

/** Forget what was sent days ago, or the record grows without limit. */
function prune(sent, today) {
  const cutoff = addDays(today, -KEEP_DAYS);
  const kept = {};
  Object.entries(sent).forEach(([key, date]) => {
    if (typeof date === "string" && date >= cutoff) kept[key] = date;
  });
  return kept;
}
