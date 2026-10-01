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

/** Spending that counts: not a transfer to yourself, not outside the plan. */
export const counts = (entry) => entry
  && entry.amount < 0
  && !entry.deleted
  && (entry.category || "other") !== "transfers"
  && entry.branch !== "external";

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
export function unbudgeted(rows, settings, date) {
  const budgets = parseBudgets(settings && settings.budgets);
  return (Array.isArray(rows) ? rows : [])
    .filter((entry) => counts(entry) && entry.date === date && !budgets.has(entry.category || "other"))
    .sort((a, b) => a.amount - b.amount);
}
