import { checkCode, cors, json, notConfigured, store, vaultKey } from "./_store.js";
import { aiClient, aiReport, MODEL } from "./_ai.js";
import { DEBRIEF_SYSTEM } from "./_playbook.js";
import { monthOf, parseBudgets, weekReview, weekStart } from "./_budget.js";
import { listSubscriptions } from "./_push.js";

/**
 * The week, read back on a Sunday evening.
 *
 *   POST /api/debrief            write this week's, for every vault with a
 *                                device on it, where it is Sunday evening
 *   GET  /api/debrief?code=...   what was written
 *
 * It is its own route rather than part of the reminder run because it calls
 * Claude, which takes tens of seconds, and the reminder run has to stay quick
 * enough to be called every quarter of an hour. The reminder run only ever
 * reads what this one left behind, so a debrief that failed to generate makes
 * no notification rather than a notification about nothing.
 */

export const maxDuration = 60;

/* When a Sunday is late enough to look back on. */
const EVENING = 18;
const WINDOW_HOURS = 4;
const KEEP_WEEKS = 8;

export const debriefKey = (vault) => `debrief_${vault}`;

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method === "GET") return read(req, res);
  if (req.method !== "POST") return json(res, 405, { error: "method-not-allowed" });

  const secret = process.env.CRON_SECRET;
  const offered = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (secret && offered !== secret) {
    return json(res, 200, { ok: true, dryRun: true, message: "No secret, so nothing was written." });
  }

  const live = store();
  if (!live) return notConfigured(res);
  if (!aiReport().configured) {
    return json(res, 503, { ok: false, message: "No API key, so nothing can be read." });
  }

  const force = new URL(req.url, "http://localhost").searchParams.get("force") === "1";

  try {
    const vaults = new Map();
    for (const device of await listSubscriptions(live)) {
      if (!vaults.has(device.vault)) vaults.set(device.vault, device.zone || "Europe/Warsaw");
    }

    const written = [];
    for (const [vault, zone] of vaults) {
      const result = await writeFor(live, vault, zone, force);
      written.push({ vault: vault.slice(0, 8), ...result });
    }

    return json(res, 200, { ok: true, vaults: vaults.size, written });
  } catch (err) {
    console.error("debrief failed:", err.status || "", err.message);
    return json(res, 502, { ok: false, message: err.message });
  }
}

/** What the app asks for when it opens: whatever was last written. */
async function read(req, res) {
  const live = store();
  if (!live) return notConfigured(res);

  const code = new URL(req.url, "http://localhost").searchParams.get("code") || "";
  const problem = checkCode(code);
  if (problem) return json(res, 400, { error: "bad-code", message: problem });

  const held = await readJson(live, debriefKey(vaultKey(code.trim())));
  const weeks = Array.isArray(held) ? held : [];
  return json(res, 200, { ok: true, weeks: weeks.slice(-KEEP_WEEKS) });
}

async function writeFor(live, vault, zone, force) {
  const clock = localDate(zone);
  const sunday = clock.date;

  // Sunday, and late enough in it to be looking back rather than forward.
  const isSunday = new Date(`${sunday}T12:00:00Z`).getUTCDay() === 0;
  if (!force && (!isSunday || clock.hour < EVENING || clock.hour >= EVENING + WINDOW_HOURS)) {
    return { skipped: "not a Sunday evening there", at: clock.time };
  }

  const held = await readJson(live, debriefKey(vault));
  const weeks = Array.isArray(held) ? held : [];
  const week = weekStart(sunday);
  if (!force && weeks.some((one) => one.week === week)) return { skipped: "already written", week };

  const raw = await live.get(vault);
  const data = raw ? safeParse(raw) : null;
  const rows = data && Array.isArray(data.transactions) ? data.transactions : [];
  const settings = data && typeof data.moneySettings === "object" ? data.moneySettings : null;

  if (!settings || !(settings.budgets || settings.income) || rows.length === 0) {
    return { skipped: "nothing to read", week };
  }

  const review = weekReview(rows, settings, sunday);
  if (review.now.count === 0) return { skipped: "nothing was spent", week };

  const answer = await ask(digestOf(review, settings));
  const record = {
    week,
    sunday,
    at: new Date().toISOString(),
    spent: review.now.out,
    allowed: review.allowed,
    ...answer,
  };

  await live.put(debriefKey(vault), JSON.stringify([...weeks, record].slice(-KEEP_WEEKS)));
  return { week, written: true };
}

/* ---------- What the model is given ---------- */

const zl = (grosze) => Math.round(grosze) / 100;

function digestOf(review, settings) {
  const categories = [...review.now.byCategory.entries()]
    .map(([name, out]) => ({
      name,
      out: zl(out),
      lastWeek: zl(review.before.byCategory.get(name) || 0),
      monthlyBudget: review.budgets.has(name) ? zl(review.budgets.get(name)) : null,
    }))
    .sort((a, b) => b.out - a.out);

  return {
    currency: "PLN",
    week: { from: review.monday, to: review.sunday },
    allowed: zl(review.allowed),
    spent: zl(review.now.out),
    spentLastWeek: zl(review.before.out),
    cameIn: zl(review.in),
    weekdays: { allowed: zl(review.weekdayAllowed), spent: zl(review.weekdaySpent) },
    weekend: { allowed: zl(review.weekendAllowed), spent: zl(review.weekendSpent) },
    daysOverTheirLimit: review.daysOver,
    perDay: review.now.days.map((day) => ({
      date: day.date, weekend: day.weekend, limit: zl(day.limit), spent: zl(day.spent),
    })),
    categories,
    biggest: review.now.biggest.map((entry) => ({
      what: entry.counterparty || entry.title || "—",
      amount: zl(Math.abs(entry.amount)),
      date: entry.date,
      category: entry.category || "other",
    })),
    monthlyPlan: zl([...parseBudgets(settings.budgets).values()].reduce((sum, limit) => sum + limit, 0)),
    month: monthOf(review.sunday),
  };
}

const SHAPE = {
  type: "object",
  properties: {
    headline: {
      type: "string",
      description: "The line that goes to their phone, under twelve words, with the number in it. How the week went, said plainly.",
    },
    performance: {
      type: "string",
      description: "How the week actually went against what it was allowed, in two or three sentences with the figures. Weekdays and the weekend separately, because they are budgeted separately.",
    },
    kept: {
      type: "string",
      description: "What went well, in one or two sentences. If nothing did, say what came closest rather than inventing something.",
    },
    curb: {
      type: "string",
      description: "The one thing worth curbing next week and what it would save, named precisely — the shop, the habit, the day of the week it happens on. One or two sentences. If nothing needs curbing, say so plainly.",
    },
    nextWeek: {
      type: "string",
      description: "One concrete thing to do differently, small enough to actually do. Not 'spend less'.",
    },
  },
  required: ["headline", "performance", "kept", "curb", "nextWeek"],
};

async function ask(digest) {
  const client = aiClient();
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: DEBRIEF_SYSTEM,
    messages: [{ role: "user", content: `Here is my week.\n\n${JSON.stringify(digest, null, 1)}` }],
    tools: [{
      name: "report",
      description: "Report the week back. Always answer by calling this.",
      input_schema: SHAPE,
    }],
  });

  const reported = message.content.find((block) => block.type === "tool_use");
  if (reported && SHAPE.required.every((field) => reported.input[field] !== undefined)) {
    return { result: reported.input, cost: usageOf(message) };
  }

  const prose = message.content.filter((block) => block.type === "text")
    .map((block) => block.text).join("").trim();
  const err = new Error(prose ? "The week came back as prose rather than a report." : "The week came back empty.");
  err.status = 502;
  throw err;
}

const usageOf = (message) => ({
  in: (message.usage && message.usage.input_tokens) || 0,
  out: (message.usage && message.usage.output_tokens) || 0,
});

/* ---------- Odds and ends ---------- */

/** The date and hour where the reader is, not where the server is. */
export function localDate(zone, now = new Date()) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone || "UTC",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(now);
  } catch (err) {
    return localDate("UTC", now);
  }
  const at = {};
  parts.forEach((part) => { at[part.type] = part.value; });
  return {
    date: `${at.year}-${at.month}-${at.day}`,
    hour: Number(at.hour) % 24,
    time: `${at.hour}:${at.minute}`,
  };
}

async function readJson(live, key) {
  const raw = await live.get(key);
  if (!raw) return null;
  return safeParse(raw);
}

function safeParse(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (err) {
    return null;
  }
}
