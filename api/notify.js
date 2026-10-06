import { cors, json, notConfigured, store } from "./_store.js";
import { forgetSubscription, listSubscriptions, saveSubscription, sendPush, vapidKeys } from "./_push.js";
import { dayBudget, NEARLY, shiftISO, unbudgeted, weekendPurse } from "./_budget.js";
import { debriefKey } from "./debrief.js";

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
/*
  Five in the afternoon: the evening has something in it, and there is still
  time to arrange the rest of the day around it. The sitting itself is at the
  hour it was planned for, which the app puts at seven unless the planner
  moved it or the reader pushed it back.

  Fixed hours rather than an offset from the sitting, because a habit is
  built on a time of day and not on a moving target.
*/
const HEADS_UP_MINUTES = 17 * 60;
const WINDOW_MINUTES = 90;       // How late a reminder may be and still be worth sending.
const KEEP_DAYS = 3;             // How long to remember what was already sent.

/*
  The morning text, on weekdays. 08:15 is when it was asked for; the window is
  wide because the scheduler behind this is a cron that is often minutes late
  and occasionally an hour, and a budget for the day is still worth having at
  nine. Sent once, whenever within the window the run happens to land.
*/
const MORNING_AT = 8 * 60 + 15;
const MORNING_WINDOW = 90;

/*
  How much of a day may be gone before it is worth saying so. The money alerts
  are deliberately few: one when the day is nearly spent, one when it is, and
  one for a payment nothing was budgeted for. A phone that buzzes at every
  coffee gets silenced, and then none of this works at all.
*/
const UNBUDGETED_FLOOR = 2000;   // 20 zl: smaller than that is not worth a buzz.

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
    const debriefs = new Map();
    const report = [];
    let sentCount = 0;

    for (const device of devices) {
      const clock = localClock(device.zone);
      if (!vaults.has(device.vault)) vaults.set(device.vault, await readVault(live, device.vault));
      const vault = vaults.get(device.vault);

      if (!debriefs.has(device.vault)) {
        debriefs.set(device.vault, await readDebriefs(live, device.vault));
      }

      const sent = typeof device.sent === "object" && device.sent ? { ...device.sent } : migrate(device);
      const waiting = dueReminders(vault, clock, debriefs.get(device.vault))
        .filter((item) => !sent[item.key]);

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

async function readDebriefs(live, vault) {
  const raw = await live.get(debriefKey(vault));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

async function readVault(live, key) {
  const empty = { tasks: [], coursework: [], sessions: [], transactions: [], moneySettings: {} };
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
export function dueReminders(vault, clock, debriefs = null) {
  const due = [...moneyAlerts(vault, clock), ...debriefReady(debriefs, clock)];

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

      /*
        The title carries the whole message, work included: a lock screen shows
        it with the app's name beside it and the body cut short, so "Time to
        study" on its own says nothing about what. Worded to match the app's own
        reminders and the calendar alarms, which say the same thing.
      */
      const moments = [
        {
          key: `session-soon:${session.id}`,
          at: Math.min(HEADS_UP_MINUTES, at - 30),
          title: `Tonight: ${name}`,
          body: `${session.minutes} minutes at ${session.deferredTo || session.time}`,
        },
        {
          key: `session-now:${session.id}`,
          at: minutesOf(session.deferredTo) === null ? at : minutesOf(session.deferredTo),
          title: `Time to start: ${name}`,
          body: `${session.minutes} minutes. Open Get a grip to run the clock.`,
        },
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

/*
  The Sunday debrief, once it exists.
  
  This only ever reads what /api/debrief left behind, so a week that failed to
  generate makes no notification at all rather than a notification about
  nothing. The headline is the model's own, written to be read on a lock
  screen; the rest of it waits in the app.
*/
export function debriefReady(debriefs, clock) {
  const weeks = Array.isArray(debriefs) ? debriefs : [];
  if (weeks.length === 0) return [];

  const held = weeks[weeks.length - 1];
  if (!held || !held.result || !held.result.headline) return [];

  /*
    The evening it was written, and the morning after for anybody who was out.
    Keyed to the debrief's own Sunday rather than to today's week, because by
    Monday today's week is a different one and the week being announced has
    just ended.
  */
  const thisEvening = clock.today === held.sunday && clock.hour >= 18;
  const nextMorning = clock.today === shiftISO(held.sunday, 1);
  if (!thisEvening && !nextMorning) return [];

  return [alert(`debrief:${held.week}`, "Your week is ready",
    String(held.result.headline).slice(0, 160), clock)];
}

/* ---------- The money alerts ---------- */

/*
  What the day looks like from here, and whether any of it is worth a buzz.

  Everything is worked out in the device's own zone from the vault's own
  transactions, and everything is keyed by the local date, so a run that fires
  five times in a minute sends one of each and a run that is late still sends
  it. The settings come from the vault too -- they are pushed there by the app
  precisely so this function can read them.

  How fresh any of it is depends on the bank, and the bank is polled rather
  than listening: PSD2 allows four unattended fetches a day, which is why the
  schedule pulls at the four moments that make these alerts useful rather than
  every quarter of an hour. Opening the app fetches again, with the reader
  present, and that one does not count against the four.
*/
export function moneyAlerts(vault, clock) {
  const settings = vault && typeof vault.moneySettings === "object" ? vault.moneySettings : null;
  if (!settings || !(settings.budgets || settings.income)) return [];

  const rows = alive(vault.transactions);
  if (rows.length === 0) return [];

  const today = dayBudget(rows, settings, clock.today);
  if (!today.plan.spendable) return [];

  const due = [];
  const weekday = ![0, 6].includes(new Date(`${clock.today}T12:00:00Z`).getUTCDay());

  /* The morning text: what today is allowed, and what rides on it. */
  const sinceMorning = clock.minutes - MORNING_AT;
  if (weekday && sinceMorning >= 0 && sinceMorning <= MORNING_WINDOW) {
    const purse = weekendPurse(rows, settings, clock.today);
    const carried = today.carried > 0
      ? ` ${money(today.carried)} of it carried from yesterday.`
      : today.carried < 0
        ? ` ${money(-today.carried)} less, carried from yesterday.`
        : "";

    due.push(alert(`morning:${clock.today}`, `Today: ${money(today.limit)}`,
      `${carried.trim()} ${purse.counted > 0
        ? `The weekend is on ${money(purse.purse)} so far.`
        : `A quiet day puts half of what is left on the weekend.`}`.trim(), clock));
  }

  /* Nearly there, and past it. One each, whichever way the day goes. */
  if (today.share >= 1) {
    due.push(alert(`over:${clock.today}`, `${money(today.spent - today.limit)} over today`,
      `${money(today.spent)} spent against ${money(today.limit)}. Tomorrow carries a quarter of it.`, clock));
  } else if (today.share >= NEARLY) {
    due.push(alert(`nearly:${clock.today}`, `${money(today.left)} left today`,
      `${money(today.spent)} of ${money(today.limit)} gone. Half of anything left lands on the weekend.`, clock));
  }

  /* And a payment nothing was budgeted for, which is the one that would
     otherwise quietly become a category of its own. */
  const loose = unbudgeted(rows, settings, clock.today).filter((entry) => Math.abs(entry.amount) >= UNBUDGETED_FLOOR);
  if (loose.length > 0) {
    const worst = loose[0];
    const what = worst.counterparty || worst.title || worst.description || "something";
    due.push(alert(`loose:${clock.today}:${worst.id}`,
      `${money(Math.abs(worst.amount))} with no budget behind it`,
      `${what}, filed under ${worst.category || "other"}. Give it a limit, or move it outside the plan.`, clock));
  }

  return due;
}

const alert = (key, title, body, clock) => ({
  key,
  body: `${title}: ${body}`,
  message: { title, body, date: clock.today, tag: key },
});

/** Grosze, written the Polish way, without leaning on the server's locale. */
function money(grosze) {
  const sign = grosze < 0 ? "−" : "";
  const whole = String(Math.floor(Math.abs(grosze) / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
  return `${sign}${whole},${String(Math.abs(grosze) % 100).padStart(2, "0")} zł`;
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
