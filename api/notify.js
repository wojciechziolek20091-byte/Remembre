import { cors, json, notConfigured, store } from "./_store.js";
import { forgetSubscription, listSubscriptions, saveSubscription, sendPush, vapidKeys } from "./_push.js";

/**
 * The nightly run. Vercel's scheduler calls this; so can anybody, which is
 * fine, because what it does is decided by each device's own clock and by
 * whether that device has already had today's reminder. Calling it twice sends
 * nothing twice.
 *
 * The hour matters and the server's clock is UTC, so every decision here is
 * made in the device's own time zone. A Hobby account may only schedule this
 * once a day, so the rule is "it is past 17:00 where this device is, and it has
 * not been told about tomorrow yet" rather than "it is exactly 17:00".
 */

const REMINDER_HOUR = 17;

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "GET" && req.method !== "POST") {
    return json(res, 405, { error: "method-not-allowed" });
  }

  // Vercel signs its own scheduled calls. When a secret is set, anything else
  // may still ask for a dry run but may not cause a send.
  const secret = process.env.CRON_SECRET;
  const offered = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const trusted = !secret || offered === secret;

  const url = new URL(req.url, "http://localhost");
  const dryRun = url.searchParams.get("dry") === "1" || !trusted;

  const live = store();
  if (!live) return notConfigured(res);
  if (!vapidKeys()) {
    return json(res, 503, {
      error: "no-keys",
      message: "No VAPID keys are set, so nothing can be sent.",
    });
  }

  try {
    const devices = await listSubscriptions(live);
    const report = [];

    for (const device of devices) {
      const clock = localClock(device.zone);
      const outcome = { device: device.id, zone: device.zone, at: clock.time };

      if (clock.hour < REMINDER_HOUR) {
        report.push({ ...outcome, sent: false, why: "too early where this device is" });
        continue;
      }
      if (device.lastSentFor === clock.tomorrow) {
        report.push({ ...outcome, sent: false, why: "already told about tomorrow" });
        continue;
      }

      const vault = await readVault(live, device.vault);
      const message = digest(vault, clock.tomorrow);
      if (!message) {
        // Nothing due is still an answer for today, so tomorrow's run starts clean.
        await saveSubscription(live, device.id, { ...device, lastSentFor: clock.tomorrow });
        report.push({ ...outcome, sent: false, why: "nothing due tomorrow" });
        continue;
      }

      if (dryRun) {
        report.push({ ...outcome, sent: false, why: "dry run", would: message.body });
        continue;
      }

      const result = await sendPush(device, JSON.stringify(message));
      if (result.gone) {
        await forgetSubscription(live, device.id);
        report.push({ ...outcome, sent: false, why: "this device is gone; forgotten" });
        continue;
      }
      if (!result.ok) {
        report.push({ ...outcome, sent: false, why: `push service said ${result.status}`, detail: result.detail });
        continue;
      }

      await saveSubscription(live, device.id, { ...device, lastSentFor: clock.tomorrow });
      report.push({ ...outcome, sent: true, body: message.body });
    }

    return json(res, 200, { ok: true, dryRun, devices: devices.length, report });
  } catch (err) {
    console.error("notify failed:", err);
    return json(res, 502, { error: "failed", message: String(err && err.message) });
  }
}

/* ---------- What time is it where the reader is? ---------- */

/**
 * The device's own wall clock, and the date it will call tomorrow. Built from
 * the zone name rather than a stored offset, so it stays right across a
 * daylight-saving change without the device having to check in.
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
  const today = `${at.year}-${at.month}-${at.day}`;

  // Adding a day to a plain date, without letting a time zone near it.
  const [y, m, d] = today.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const tomorrow = next.toISOString().slice(0, 10);

  return { hour, today, tomorrow, time: `${at.hour}:${at.minute}` };
}

/* ---------- What is due? ---------- */

async function readVault(live, key) {
  const raw = await live.get(key);
  if (!raw) return { tasks: [], coursework: [], sessions: [] };
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : { tasks: [], coursework: [], sessions: [] };
  } catch (err) {
    return { tasks: [], coursework: [], sessions: [] };
  }
}

const live_ = (list) => (Array.isArray(list) ? list : []).filter((r) => r && !r.deleted);

/**
 * One notification, or null when there is nothing worth interrupting anybody
 * for. Named things read better than a count, so up to three are listed and
 * the rest are summed.
 */
export function digest(vault, date) {
  const tasks = live_(vault.tasks).filter((t) => !t.done && t.date === date);
  const coursework = live_(vault.coursework).filter((c) => c.stage !== "submitted" && c.due === date);
  const sessions = live_(vault.sessions).filter((s) => !s.done && s.date === date);

  const due = [
    ...tasks.map((t) => (t.type === "test" ? `${t.title} (test)` : t.title)),
    ...coursework.map((c) => `${c.title} due`),
  ];
  if (due.length === 0 && sessions.length === 0) return null;

  const named = due.slice(0, 3);
  const rest = due.length - named.length;
  const pieces = [];
  if (named.length) pieces.push(named.join(", ") + (rest > 0 ? `, and ${rest} more` : ""));
  if (sessions.length) {
    pieces.push(`${sessions.length} study ${sessions.length === 1 ? "session" : "sessions"}`);
  }

  return {
    title: due.length ? "Remember, for tomorrow" : "Study time tomorrow",
    body: pieces.join(" · "),
    date,
    tag: `remembre-${date}`,
  };
}
