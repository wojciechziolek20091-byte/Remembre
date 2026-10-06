/*
  What a day is allowed to cost.

  This is the one piece of arithmetic that has to be agreed on by two
  runtimes: the page works it out to draw it, and this server works it out to
  decide whether to interrupt somebody's afternoon about it. They cannot share
  a module -- the page is a classic script with no build step and this is an ES
  module on a serverless function -- so the rules live here, the page keeps its
  own copy, and tools/budget-test.mjs runs both over the same fixtures and
  fails if they ever disagree by a single grosz.

  The rules themselves, in one place:

  - A month's spending money is split into a weekday rate and a weekend rate
    worth 1.8 times as much, solved against the real count of each kind of day,
    so the two come to exactly the monthly total.
  - The weekend is Friday to Sunday, because that is when it is spent.
  - Yesterday's underspend does not simply vanish, and neither does it all come
    back: half goes to the weekend, a quarter to today, and a quarter is kept.
    That last quarter is the cap -- the part of every quiet day that turns into
    savings instead of into a bigger tomorrow.
  - An overspend carries the same way, so a loud Tuesday is paid for on
    Wednesday rather than at the end of the month.
*/

export const WEEKEND_RATIO = 1.8;

/* Of what a day did not spend: half to the weekend, a quarter to tomorrow,
   and the last quarter kept. Three numbers that must add to one. */
export const CARRY_WEEKEND = 0.5;
export const CARRY_TOMORROW = 0.25;
export const CARRY_KEPT = 0.25;

/* When a day is close enough to its limit to be worth saying so. */
export const NEARLY = 0.8;

export const isWeekend = (iso) => {
  const day = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return day === 0 || day === 5 || day === 6;
};

export function shiftISO(date, by) {
  const [y, m, d] = String(date).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + by)).toISOString().slice(0, 10);
}

export const monthOf = (date) => String(date).slice(0, 7);

/** Monday, as a plain date. The week starts where the spending does. */
export function weekStart(iso) {
  const day = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return shiftISO(iso, -((day + 6) % 7));
}

export function daysOfMonth(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let weekend = 0;
  for (let day = 1; day <= last; day += 1) {
    if (isWeekend(`${monthKey}-${String(day).padStart(2, "0")}`)) weekend += 1;
  }
  return { total: last, weekend, week: last - weekend };
}

/* ---------- Reading the settings the page keeps ---------- */

/** One line per category: a name, an equals sign, a limit in zloty. */
export function parseBudgets(text) {
  const budgets = new Map();
  String(text || "").split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const at = trimmed.indexOf("=");
    if (at === -1) return;
    const category = trimmed.slice(0, at).trim().toLowerCase();
    const grosze = parseAmount(trimmed.slice(at + 1));
    if (category && grosze !== null && grosze > 0) budgets.set(category, grosze);
  });
  return budgets;
}

/** One line per instalment: the day of the month, an equals sign, an amount. */
export function parseIncomePlan(text) {
  const slots = [];
  String(text || "").split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const at = trimmed.indexOf("=");
    if (at === -1) return;
    const day = Number(trimmed.slice(0, at).trim());
    const amount = parseAmount(trimmed.slice(at + 1));
    if (Number.isInteger(day) && day >= 1 && day <= 31 && amount !== null && amount > 0) {
      slots.push({ day, amount });
    }
  });
  return slots.sort((a, b) => a.day - b.day);
}

/** Polish money, read as whole grosze. The same reader the importer uses. */
export function parseAmount(text) {
  let clean = String(text).replace(/[\s  ]/g, "").replace(/PLN|zl|zł/gi, "").trim();
  if (!clean) return null;

  const negative = clean.startsWith("-") || clean.endsWith("-");
  clean = clean.replace(/-/g, "");

  const decimalAt = Math.max(clean.lastIndexOf(","), clean.lastIndexOf("."));
  let whole = clean;
  let fraction = "";
  if (decimalAt !== -1) {
    whole = clean.slice(0, decimalAt);
    fraction = clean.slice(decimalAt + 1);
    if (fraction.length === 3 && !/[.,]/.test(whole)) { whole = clean; fraction = ""; }
  }

  whole = whole.replace(/[.,]/g, "");
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(fraction)) return null;

  const grosze = Number(whole || 0) * 100 + Number((fraction + "00").slice(0, 2));
  if (!Number.isFinite(grosze)) return null;
  return negative ? -grosze : grosze;
}

/* ---------- The money that may be spent ---------- */

/**
 * Spending that counts against the month.
 *
 * Not a transfer to yourself, not something somebody else covered, and not
 * something paid for out of savings. The last two are money that was never
 * part of this month's 2 500, and counting them makes a normal month look
 * reckless on the one occasion it was anything but.
 */
export const counts = (entry) => entry
  && entry.amount < 0
  && !entry.deleted
  && (entry.category || "other") !== "transfers"
  && entry.branch !== "external"
  && entry.branch !== "savings";

export const spentOn = (rows, date) => (Array.isArray(rows) ? rows : [])
  .filter((entry) => counts(entry) && entry.date === date)
  .reduce((sum, entry) => sum + Math.abs(entry.amount), 0);

/**
 * The two rates for a month. Spendable is what the budgets add up to -- what
 * has actually been decided may be spent -- falling back to the income plan
 * when nothing has been budgeted yet.
 */
export function weekPlan(settings, monthKey) {
  const budgets = parseBudgets(settings && settings.budgets);
  const allocated = [...budgets.values()].reduce((sum, limit) => sum + limit, 0);
  const planned = parseIncomePlan(settings && settings.income)
    .reduce((sum, slot) => sum + slot.amount, 0);

  const spendable = allocated > 0 ? allocated : planned;
  const days = daysOfMonth(monthKey);
  const weekdayRate = spendable / (days.week + WEEKEND_RATIO * days.weekend);

  return {
    spendable,
    days,
    weekday: Math.round(weekdayRate),
    weekend: Math.round(weekdayRate * WEEKEND_RATIO),
  };
}

/** What one day is allowed before anything is carried into it. */
export const baseRate = (plan, date) => (isWeekend(date) ? plan.weekend : plan.weekday);

/**
 * Today's limit: its own rate, plus a quarter of what yesterday did not
 * spend. A quiet Monday makes Tuesday a little easier and the weekend
 * noticeably better, and keeps the rest.
 */
export function dayBudget(rows, settings, date) {
  const plan = weekPlan(settings, monthOf(date));
  const base = baseRate(plan, date);

  const yesterday = shiftISO(date, -1);
  const left = baseRate(plan, yesterday) - spentOn(rows, yesterday);
  const carried = Math.round(left * CARRY_TOMORROW);

  const limit = Math.max(0, base + carried);
  const spent = spentOn(rows, date);

  return {
    date, plan, base, carried, limit, spent,
    left: limit - spent,
    share: limit > 0 ? spent / limit : 0,
    yesterdayLeft: left,
  };
}

/**
 * What the weekend has: its own three days, plus half of everything Monday to
 * Thursday did not spend. Only finished days count -- today is still being
 * spent, and counting it would promise money that has not been saved.
 */
export function weekendPurse(rows, settings, today) {
  const monday = weekStart(today);
  const plan = weekPlan(settings, monthOf(today));

  let saved = 0;
  let counted = 0;
  for (let i = 0; i < 4; i += 1) {
    const date = shiftISO(monday, i);
    if (date >= today) break;
    saved += plan.weekday - spentOn(rows, date);
    counted += 1;
  }

  const carried = Math.round(saved * CARRY_WEEKEND);
  const base = plan.weekend * 3;
  const spentSoFar = [4, 5, 6]
    .map((i) => shiftISO(monday, i))
    .filter((date) => date <= today)
    .reduce((sum, date) => sum + spentOn(rows, date), 0);

  return {
    plan, monday, counted, saved, carried, base,
    purse: base + carried,
    left: base + carried - spentSoFar,
    spentSoFar,
  };
}

/** Spending today in a category with no limit against it. */
/* ---------- The guard ---------- */

/*
  Whether the spending is getting away, which is not the same question as
  whether today went over.

  One day means nothing here. A day at zero and a day at 200 are both ordinary:
  a textbook, a night out, a week of packed lunches. A tripwire on the daily
  limit fires on every one of those and is therefore ignored within a week,
  which makes it worse than no alarm at all.

  What does mean something is a run. Two days over the rate in a row, with the
  week as a whole above its allowance, is a direction rather than an event. So
  the guard reads two things together: how many days in a row have been over,
  and what the last week has cost against what the last week was allowed.

  A single enormous day with a quiet week around it stays quiet. A week of
  small overruns with no single day that looks bad raises it.
*/

/* The window the load is measured over: long enough for a spike to average
   out, short enough to still be about now. */
export const GUARD_WINDOW = 7;
/* Days in a row over the rate before a run is a run rather than a Tuesday. */
export const GUARD_RUN = 2;
/* What the window may cost against what it was allowed. */
export const GUARD_WATCH = 1.15;
export const GUARD_OVER = 1.35;

/**
 * The last week, day by day, and what it adds up to.
 *
 * `run` counts back from the given day: how many consecutive days, ending
 * there, cost more than that day's own rate. A day with nothing on it yet
 * (today, before anything has been spent) ends a run rather than extending it.
 */
export function pressure(rows, settings, date) {
  const days = [];
  for (let back = GUARD_WINDOW - 1; back >= 0; back -= 1) {
    const when = shiftISO(date, -back);
    const plan = weekPlan(settings, monthOf(when));
    const rate = baseRate(plan, when);
    const spent = spentOn(rows, when);
    days.push({ date: when, spent, rate, over: spent - rate });
  }

  const spent = days.reduce((sum, day) => sum + day.spent, 0);
  const allowed = days.reduce((sum, day) => sum + day.rate, 0);
  const load = allowed > 0 ? spent / allowed : 0;

  let run = 0;
  for (let i = days.length - 1; i >= 0; i -= 1) {
    if (days[i].spent > days[i].rate && days[i].rate > 0) run += 1;
    else break;
  }

  /*
    A run is the trigger, the week is the severity. Two days over the rate in a
    row is worth hearing about even when the week can still carry it -- that is
    the whole point of watching runs on somebody whose days swing from nothing
    to two hundred -- but what it is called depends on whether the week behind
    it agrees.
  */
  const level = load >= GUARD_OVER || run >= GUARD_RUN + 1 || (run >= GUARD_RUN && load >= GUARD_WATCH)
    ? "over"
    : run >= GUARD_RUN || load >= GUARD_WATCH
      ? "watch"
      : "calm";

  const worst = days.reduce((held, day) => (day.over > held.over ? day : held), days[0]);

  return { days, run, spent, allowed, load, level, worst, over: Math.max(0, spent - allowed) };
}

/**
 * What the guard has to say, in the words it would say it in.
 *
 * A run with a quiet week behind it is said as what it is -- a nudge -- rather
 * than dressed up as a crisis. Crying wolf is how an alert stops being read,
 * and this one has to still be worth reading in March.
 */
export function guardWords(read) {
  if (!read || read.level === "calm") return null;
  const share = Math.round(read.load * 100);

  if (read.run >= GUARD_RUN) {
    return {
      title: `${read.run} days over in a row`,
      body: read.load >= 1
        ? `The week is at ${share}% of what it allows. One big day is nothing; ${read.run} in a row is a direction.`
        : `The week is still inside its rate at ${share}%, so this is a nudge rather than a problem.`,
    };
  }
  return {
    title: `The week is at ${share}% of its rate`,
    body: "No single day looks bad, which is how this one gets past you.",
  };
}

export function unbudgeted(rows, settings, date) {
  const budgets = parseBudgets(settings && settings.budgets);
  return (Array.isArray(rows) ? rows : [])
    .filter((entry) => counts(entry) && entry.date === date && !budgets.has(entry.category || "other"))
    .sort((a, b) => a.amount - b.amount);
}

/* ---------- The week, looked back on ---------- */

/*
  Everything the Sunday debrief needs, worked out here so the thing that calls
  Claude does arithmetic in one place and prose in another.

  A week is Monday to Sunday. The comparison is the week before it, because a
  figure on its own says nothing: 240 zl of food is a good week or a bad one
  only against the last one.
*/
export function weekReview(rows, settings, sunday) {
  const monday = weekStart(sunday);
  const plan = weekPlan(settings, monthOf(sunday));
  const budgets = parseBudgets(settings && settings.budgets);

  /* A week can straddle two months, and the two months rarely have the same
     count of weekend days, so each day is rated by its own month. */
  const rateFor = (date) => baseRate(weekPlan(settings, monthOf(date)), date);
  const live = (Array.isArray(rows) ? rows : []).filter((entry) => entry && !entry.deleted);

  const week = (from) => {
    const days = Array.from({ length: 7 }, (unused, i) => shiftISO(from, i));
    const inside = live.filter((entry) => counts(entry) && days.includes(entry.date));

    const byCategory = new Map();
    inside.forEach((entry) => {
      const name = entry.category || "other";
      byCategory.set(name, (byCategory.get(name) || 0) + Math.abs(entry.amount));
    });

    return {
      from,
      to: days[6],
      days: days.map((date) => ({
        date,
        weekend: isWeekend(date),
        limit: rateFor(date),
        spent: spentOn(live, date),
      })),
      out: inside.reduce((sum, entry) => sum + Math.abs(entry.amount), 0),
      count: inside.length,
      byCategory,
      biggest: inside.slice().sort((a, b) => a.amount - b.amount).slice(0, 4),
    };
  };

  const now = week(monday);
  const before = week(shiftISO(monday, -7));

  const weekdays = now.days.filter((day) => !day.weekend);
  const weekend = now.days.filter((day) => day.weekend);
  const over = now.days.filter((day) => day.spent > day.limit);

  return {
    monday,
    sunday: now.to,
    plan,
    now,
    before,
    allowed: now.days.reduce((sum, day) => sum + day.limit, 0),
    weekdaySpent: weekdays.reduce((sum, day) => sum + day.spent, 0),
    weekdayAllowed: weekdays.reduce((sum, day) => sum + day.limit, 0),
    weekendSpent: weekend.reduce((sum, day) => sum + day.spent, 0),
    weekendAllowed: weekend.reduce((sum, day) => sum + day.limit, 0),
    daysOver: over.map((day) => day.date),
    in: live
      .filter((entry) => entry.amount > 0 && entry.branch !== "external"
        && entry.date >= monday && entry.date <= now.to)
      .reduce((sum, entry) => sum + entry.amount, 0),
    budgets,
  };
}
