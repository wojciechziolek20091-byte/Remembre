/*
  The money half of Get a grip.

  Step one: bring transactions in from an mBank CSV export, store them beside
  everything else the app keeps, and show them. Categories, budgets and the
  bank connection come after this works.

  Two decisions run through all of it.

  Amounts are whole grosze, never decimal numbers. 0.1 + 0.2 is not 0.3 in
  binary floating point, and a running total of a year of spending built out of
  such numbers drifts. Everything here is an integer until the moment it is
  printed.

  A transaction's id IS the fingerprint of its content, so importing the same
  export twice cannot produce two rows: the second import computes the same ids
  and merges onto the same records. That also means the de-duplication holds
  across devices, because the phone computes the same ids as the iPad.
*/

const MONEY_KEY = "remembre.transactions.v1";

/* ---------- Reading what the bank gives you ---------- */

/*
  mBank writes a preamble -- account number, date range, filters -- before the
  real table, so the header is found rather than assumed to be the first line.
  The column names are matched loosely: the export has led with "#" for years,
  but that is a formatting flourish, not a promise.
*/
const MBANK_COLUMNS = {
  date: ["data operacji", "data transakcji"],
  booked: ["data ksiegowania", "data księgowania"],
  description: ["opis operacji", "typ operacji"],
  title: ["tytul", "tytuł"],
  counterparty: ["nadawca/odbiorca", "nadawca / odbiorca", "kontrahent"],
  account: ["numer konta", "rachunek"],
  amount: ["kwota"],
  balance: ["saldo po operacji", "saldo"],
};

/** Strips the "#", the accents and the case, so a header can be recognised. */
function normaliseHeader(text) {
  return String(text)
    .replace(/^﻿/, "")
    .replace(/^#/, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ł/g, "l")      // ł has no combining form to strip
    .trim()
    .toLowerCase();
}

/**
 * mBank exports have historically been Windows-1250 and are now often UTF-8.
 * Decoding as UTF-8 first and looking for the replacement character tells the
 * two apart without having to ask: valid UTF-8 never decodes to U+FFFD.
 */
function decodeCsv(buffer) {
  const utf8 = new TextDecoder("utf-8").decode(buffer);
  if (!utf8.includes("�")) return utf8;
  try {
    return new TextDecoder("windows-1250").decode(buffer);
  } catch (err) {
    return utf8;
  }
}

/** A CSV line splitter that understands quoted fields containing separators. */
function splitRow(line, separator) {
  const cells = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') { cell += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') {
      quoted = true;
    } else if (char === separator) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells.map((value) => value.trim());
}

/**
 * Polish money is written 1 234,56 -- space for thousands, comma for the
 * decimal -- but an export can arrive either way round, so the separator that
 * appears last is taken as the decimal one. Returns whole grosze.
 */
function parseAmount(text) {
  let clean = String(text)
    .replace(/[\s  ]/g, "")
    .replace(/PLN|zl|zł/gi, "")
    .trim();
  if (!clean) return null;

  const negative = clean.startsWith("-") || clean.endsWith("-");
  clean = clean.replace(/-/g, "");

  const lastComma = clean.lastIndexOf(",");
  const lastDot = clean.lastIndexOf(".");
  const decimalAt = Math.max(lastComma, lastDot);

  let whole = clean;
  let fraction = "";
  if (decimalAt !== -1) {
    whole = clean.slice(0, decimalAt);
    fraction = clean.slice(decimalAt + 1);
    // Three digits after the separator means it was grouping, not a decimal.
    if (fraction.length === 3 && !/[.,]/.test(whole)) {
      whole = clean;
      fraction = "";
    }
  }

  whole = whole.replace(/[.,]/g, "");
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(fraction)) return null;

  const grosze = Number(whole || "0") * 100 + Number((fraction + "00").slice(0, 2) || "0");
  if (!Number.isFinite(grosze)) return null;
  return negative ? -grosze : grosze;
}

/** Accepts the YYYY-MM-DD mBank writes, and DD.MM.YYYY in case it does not. */
function parseDate(text) {
  const value = String(text).trim();
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  match = /^(\d{2})[.\/](\d{2})[.\/](\d{4})$/.exec(value);
  if (match) return `${match[3]}-${match[2]}-${match[1]}`;
  return "";
}

/**
 * Turns the file into rows. Throws with something a reader can act on rather
 * than returning an empty list and leaving them guessing.
 */
function parseMbankCsv(text) {
  const lines = text.split(/\r?\n/);

  const headerAt = lines.findIndex((line) =>
    MBANK_COLUMNS.date.some((name) => normaliseHeader(line.split(";")[0] || "") === name)
    || /(^|;)\s*#?\s*Data operacji/i.test(line));
  if (headerAt === -1) {
    throw new Error("That file has no “Data operacji” column, so it is not an mBank operations export.");
  }

  const separator = (lines[headerAt].match(/;/g) || []).length >= (lines[headerAt].match(/,/g) || []).length ? ";" : ",";
  const headers = splitRow(lines[headerAt], separator).map(normaliseHeader);

  const column = {};
  Object.entries(MBANK_COLUMNS).forEach(([field, names]) => {
    column[field] = headers.findIndex((header) => names.includes(header));
  });
  if (column.date === -1 || column.amount === -1) {
    throw new Error("That export is missing the date or the amount column.");
  }

  const rows = [];
  for (let i = headerAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;

    const cells = splitRow(line, separator);
    const date = parseDate(cells[column.date] || "");
    const amount = parseAmount(cells[column.amount] || "");
    // The footer mBank appends -- totals, a blank row -- has neither.
    if (!date || amount === null) continue;

    const at = (field) => (column[field] === -1 ? "" : String(cells[column[field]] || "").replace(/\s+/g, " ").trim());
    rows.push({
      date,
      booked: parseDate(at("booked")) || date,
      description: at("description"),
      title: at("title"),
      counterparty: at("counterparty"),
      account: at("account"),
      amount,
      balance: parseAmount(at("balance")),
    });
  }

  return rows;
}

/* ---------- Giving each one a name it will keep ---------- */

/*
  The id is a hash of everything the bank told us about the row, plus which
  occurrence of an identical row this is. Two coffees of the same price on the
  same day at the same shop are two transactions, not one, and without the
  index the second would silently vanish into the first. The count is taken in
  file order, which a statement is stable in, so re-importing an overlapping
  export lands on the same ids again.
*/
async function fingerprint(row, occurrence) {
  const text = [
    row.date, row.booked, row.amount, row.title,
    row.counterparty, row.account, row.description, occurrence,
  ].join("␟");

  const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function identify(rows) {
  const seen = new Map();
  const out = [];
  for (const row of rows) {
    const key = [row.date, row.amount, row.title, row.counterparty].join("␟");
    const occurrence = (seen.get(key) || 0) + 1;
    seen.set(key, occurrence);
    out.push({ ...row, id: await fingerprint(row, occurrence) });
  }
  return out;
}

/* ---------- Storing them ---------- */

function normaliseTransaction(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string" || !raw.id) return null;
  const amount = Math.round(Number(raw.amount));
  if (!Number.isFinite(amount)) return null;

  const createdAt = typeof raw.createdAt === "string" && raw.createdAt
    ? raw.createdAt
    : new Date().toISOString();

  return {
    id: raw.id,
    date: String(raw.date || ""),
    booked: String(raw.booked || raw.date || ""),
    description: String(raw.description || "").slice(0, 200),
    title: String(raw.title || "").slice(0, 300),
    counterparty: String(raw.counterparty || "").slice(0, 200),
    account: String(raw.account || "").slice(0, 60),
    amount,
    balance: Number.isFinite(Number(raw.balance)) ? Math.round(Number(raw.balance)) : null,
    category: String(raw.category || "").slice(0, 40),
    /*
      Which side of the income plan this sits on.

      Money in is one of two things and never a third: "plan" is the 2 500 that
      arrives on schedule, "external" is anything else that turned up. Money out
      is one of three: part of the month, "external" when somebody else's money
      paid for it, or "savings" when it came out of what had been put by.

      The last one is the one that was missing. A 400 zl one-off paid for out of
      savings was landing in the month as ordinary spending and making an
      ordinary month look reckless, and the only way out of it was to call it
      external, which said somebody else had paid -- a different and untrue
      thing. Empty means nobody has decided yet, which for anything large is a
      question the page asks rather than a guess it makes.
    */
    branch: ["plan", "external", "savings"].includes(raw.branch) ? raw.branch : "",
    linkedTo: String(raw.linkedTo || "").slice(0, 40),
    // Set when a payment was put back into the month by hand, so the linker
    // does not quietly take it out again on the next pass.
    counted: raw.counted === true,
    // And set when the category was chosen by hand, so the rules leave it be.
    fixed: raw.fixed === true,
    /*
      Seen by the bank but not yet booked: a card payment is authorised at the
      till and settles hours or a day later. It spends like any other payment
      and counts like any other payment -- the flag exists so the page can say
      the figure may still move, and is cleared when the booked twin arrives.
    */
    pending: raw.pending === true,
    source: raw.source === "api" ? "api" : "csv",
    deleted: raw.deleted === true,
    createdAt,
    updatedAt: typeof raw.updatedAt === "string" && raw.updatedAt ? raw.updatedAt : createdAt,
  };
}

function loadTransactions() {
  const raw = readStore(MONEY_KEY, []);
  return (Array.isArray(raw) ? raw : []).map(normaliseTransaction).filter(Boolean);
}

function saveTransactions() {
  if (!writeStore(MONEY_KEY, state.transactions)) {
    announce("Your browser would not let this page save data, so the import will be lost when you close the tab.");
  }
  cloudSchedulePush();
}

const liveTransactions = () => state.transactions.filter((entry) => !entry.deleted);

/**
 * Folds an import into what is already stored. A row whose id is already there
 * is left alone rather than overwritten: the stored one may have been
 * categorised by hand, and the bank has not told us anything new about it.
 */
function mergeTransactions(incoming) {
  const byId = new Map(state.transactions.map((entry) => [entry.id, entry]));
  let added = 0;
  let already = 0;

  incoming.forEach((row) => {
    if (byId.has(row.id)) {
      already += 1;
      return;
    }
    const record = normaliseTransaction({ ...row, source: "csv" });
    if (!record) return;
    state.transactions.push(record);
    byId.set(record.id, record);
    added += 1;
  });

  return { added, already };
}

/* ---------- Showing them ---------- */

/*
  Polish formatting, written out rather than left to toLocaleString: a browser
  with a trimmed-down ICU gives "1200,00" where it should give "1 200,00", and
  a column of figures that sometimes groups and sometimes does not is worse
  than one that never does.
*/
const zloty = (grosze) => {
  const sign = grosze < 0 ? "−" : "";
  const whole = String(Math.floor(Math.abs(grosze) / 100))
    .replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
  const part = String(Math.abs(grosze) % 100).padStart(2, "0");
  return `${sign}${whole},${part} zł`;
};

function renderMoney() {
  const list = $("money-list");
  if (!list) return;

  const entries = liveTransactions()
    .slice()
    .sort((a, b) => (a.date === b.date ? b.createdAt.localeCompare(a.createdAt) : b.date.localeCompare(a.date)));

  const summary = $("money-summary");
  if (entries.length === 0) {
    list.replaceChildren(el("p", { class: "empty", text: "Nothing imported yet. Export a CSV from mBank, or try the sample first." }));
    if (summary) summary.textContent = "";
    return;
  }

  const spent = entries.filter((e) => e.amount < 0).reduce((sum, e) => sum + e.amount, 0);
  const paidIn = entries.filter((e) => e.amount > 0).reduce((sum, e) => sum + e.amount, 0);
  if (summary) {
    summary.textContent =
      `${entries.length} transactions, ${zloty(spent)} out and ${zloty(paidIn)} in · ` +
      `${entries[entries.length - 1].date} to ${entries[0].date}`;
  }

  list.replaceChildren(el("ul", { class: "tx-list" },
    entries.slice(0, 200).map((entry) => txRow(entry))));
}

/* ---------- Importing ---------- */

async function importCsvText(text, { label = "that file" } = {}) {
  let rows;
  try {
    rows = parseMbankCsv(text);
  } catch (err) {
    setMoneyStatus(err.message, true);
    return null;
  }

  if (rows.length === 0) {
    setMoneyStatus("No transactions were found in that file.", true);
    return null;
  }

  const identified = await identify(rows);
  const result = mergeTransactions(identified);
  // What the account actually held when the statement was cut. The sum of the
  // rows cannot tell us this, so it is taken while the file is still here.
  rememberBalance(closingBalance(text, rows));
  recategorise();
  saveTransactions();
  // A fresh import usually brings the newest month with it, and opening on an
  // empty month would look like the import had failed.
  state.moneyMonth = latestMonth();
  moneyChanged();

  const parts = [];
  if (result.added) parts.push(`${result.added} added`);
  if (result.already) parts.push(`${result.already} already here`);
  setMoneyStatus(`Read ${rows.length} rows from ${label}: ${parts.join(", ")}.`, false);
  announce(`Imported ${result.added} transactions.`);
  return result;
}

function setMoneyStatus(text, stale) {
  const status = $("money-status");
  if (!status) return;
  status.textContent = text;
  status.classList.toggle("is-stale", Boolean(stale));
}

function readCsvFile(file) {
  const reader = new FileReader();
  reader.onload = () => { importCsvText(decodeCsv(reader.result), { label: file.name }); };
  reader.onerror = () => setMoneyStatus("That file could not be read.", true);
  reader.readAsArrayBuffer(file);
}

/*
  A small, obviously fake statement, so the whole path can be exercised before
  anything real is imported. It deliberately contains the two things that break
  naive importers: a preamble above the header, and the same shop twice in one
  day for the same amount.
*/
const SAMPLE_CSV = [
  "#Numer rachunku;",
  "PL61109010140000071219812874;",
  "",
  "#Data operacji;#Data ksiegowania;#Opis operacji;#Tytul;#Nadawca/Odbiorca;#Numer konta;#Kwota;#Saldo po operacji",
  "2026-09-28;2026-09-29;PLATNOSC KARTA;ZABKA Z7423 KRAKOW;ZABKA;;-12,49 PLN;1 842,10 PLN",
  "2026-09-28;2026-09-29;PLATNOSC KARTA;ZABKA Z7423 KRAKOW;ZABKA;;-12,49 PLN;1 829,61 PLN",
  "2026-09-27;2026-09-27;PRZELEW PRZYCHODZACY;Kieszonkowe;JAN ZIOLEK;PL27114020040000300201355387;1 200,00 PLN;1 854,59 PLN",
  "2026-09-26;2026-09-26;PLATNOSC KARTA;SPOTIFY P0A1B2C3;SPOTIFY AB;;-23,99 PLN;654,59 PLN",
  "2026-09-25;2026-09-26;PLATNOSC KARTA;BILET MPK KRAKOW;MPK;;-4,00 PLN;678,58 PLN",
  "2026-09-24;2026-09-25;PLATNOSC KARTA;BIEDRONKA 4471;JERONIMO MARTINS;;-86,31 PLN;682,58 PLN",
  "",
  "#Saldo koncowe;;;;;;1 842,10 PLN;",
].join("\r\n");

/* ---------- Wiring ---------- */

function setupMoney() {
  if (!$("money-area")) return;
  state.transactions = loadTransactions();

  $("money-pick").addEventListener("click", () => $("money-file").click());
  $("money-file").addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) readCsvFile(file);
    // Cleared so choosing the same file again still fires a change.
    event.target.value = "";
  });
  $("money-sample").addEventListener("click", () => {
    importCsvText(SAMPLE_CSV, { label: "the sample" });
  });

  setupRules();
  setupPaste();
  setupReport();
  setupBank();
  setupInsight();
  setupTransactionDialog();

  /*
    An installed app is resumed far more often than it is launched, and a
    resume runs nothing: no startup code, no reload, no fetch. Coming back to
    a visible money half is therefore treated as opening it, which is what
    somebody picking the iPad up to check a number means by it.
  */
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (state.area !== "money" || !$("money-area") || $("money-area").hidden) return;
    moneyOpened();
  });
  // Rules may have been edited on a visit when nothing was imported yet, and
  // transactions may have arrived from the other device since.
  recategorise();
  moneyChanged();
}

/**
 * Takes transactions from the other device. Called by the sync code, which
 * does not know what a transaction is; the last edit wins, the same rule the
 * rest of the vault uses.
 */
function mergeIncomingTransactions(incoming) {
  const byId = new Map(state.transactions.map((entry) => [entry.id, entry]));
  let changed = 0;

  incoming.map(normaliseTransaction).filter(Boolean).forEach((record) => {
    const held = byId.get(record.id);
    if (!held) {
      state.transactions.push(record);
      byId.set(record.id, record);
      changed += 1;
      return;
    }
    if (record.updatedAt > held.updatedAt) {
      Object.assign(held, record);
      changed += 1;
    }
  });

  if (changed > 0) {
    recategorise();
    writeStore(MONEY_KEY, state.transactions);
    moneyChanged();
  }
  return changed;
}

/* ---------- Deciding what each transaction was for ---------- */

/*
  The rules are text the reader owns, not a table buried in the code. One line
  per category: the name, an equals sign, then the words to look for. The first
  line that matches wins, so order is the only precedence there is -- which
  means a rule can be fixed by moving it, and that is easy to explain.

  Everything is folded before matching: accents away, case away. So "zabka"
  finds "ŻABKA" and the reader never has to think about which spelling the bank
  used.
*/

const MONEY_RULES_KEY = "remembre.moneyrules.v1";

const DEFAULT_RULES = `# One per line:  category = word, word, word
# The first matching line wins, so keep the specific ones near the top.

cash = bankomat, wyplata gotowki, atm, euronet
transfers = przelew wlasny, przelew na rachunek wlasny, blik p2p
income = kieszonkowe, wynagrodzenie, stypendium, zwrot, przelew przychodzacy

subscriptions = spotify, netflix, hbo, disney, youtube, icloud, apple.com/bill, google storage, microsoft, adobe, duolingo, openai, anthropic, claude, steam, playstation, allegro smart, canva, notion
school = ksiegarnia, empik, pwn, podrecznik, korepetycje, kurs, szkola, uczelnia, biblioteka, papiernic, swiat ksiazki
transport = mpk, ztm, skm, pkp, intercity, koleje, flixbus, bolt, uber, free now, orlen, bp, shell, circle k, lotos, parking, bilet, jakdojade, mevo
food = zabka, biedronka, lidl, carrefour, auchan, kaufland, stokrotka, dino, netto, aldi, piekarnia, restauracja, pizzeria, mcdonald, kfc, burger, bistro, kebab, glovo, pyszne, wolt, bar mleczny, kantyna
health = apteka, przychodnia, lekarz, dentysta, luxmed, medicover, enel-med, rossmann, hebe
clothes = zara, h&m, reserved, cropp, house, sinsay, mohito, nike, adidas, zalando, vinted, decathlon
fun = kino, multikino, helios, cinema, teatr, muzeum, silownia, fitness, basen, koncert, bilety
home = ikea, castorama, leroy, obi, jysk, media expert, rtv euro, x-kom, komputronik
phone = play, orange, t-mobile, plus, heyah, nju, virgin mobile
`;

/** Accents and case removed, so a pattern never has to know how it was typed. */
function fold(text) {
  return String(text)
    .replace(/ł/g, "l")
    .replace(/Ł/g, "L")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** Turns the editable text into something matchable. Bad lines are skipped. */
function parseRules(text) {
  const rules = [];
  String(text).split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const at = trimmed.indexOf("=");
    if (at === -1) return;

    const category = trimmed.slice(0, at).trim().toLowerCase();
    const patterns = trimmed.slice(at + 1)
      .split(",")
      .map((word) => fold(word.trim()))
      .filter(Boolean);
    if (category && patterns.length) rules.push({ category, patterns });
  });
  return rules;
}

function rulesText() {
  const stored = readStore(MONEY_RULES_KEY, null);
  return typeof stored === "string" && stored.trim() ? stored : DEFAULT_RULES;
}

/**
 * What one transaction was for. Money coming in with no rule of its own is
 * income rather than "other": a positive amount is already a strong signal,
 * and leaving it uncategorised makes every total read wrong.
 */
function categorise(entry, rules) {
  const haystack = fold([entry.counterparty, entry.title, entry.description].join(" "));
  const hit = rules.find((rule) => rule.patterns.some((pattern) => haystack.includes(pattern)));
  if (hit) return hit.category;
  return entry.amount > 0 ? "income" : "other";
}

/** Re-runs the rules over everything stored. Returns how many changed. */
function recategorise() {
  const rules = parseRules(rulesText());
  const now = new Date().toISOString();
  let changed = 0;

  state.transactions.forEach((entry) => {
    if (entry.deleted || entry.fixed) return;
    const category = categorise(entry, rules);
    if (entry.category === category) return;
    entry.category = category;
    entry.updatedAt = now;
    changed += 1;
  });

  if (changed > 0) saveTransactions();
  return changed;
}

/** What is in each category, biggest spend first, for tuning the rules. */
function categoryTally() {
  const totals = new Map();
  liveTransactions().forEach((entry) => {
    const key = entry.category || "other";
    const held = totals.get(key) || { category: key, count: 0, out: 0, in: 0 };
    held.count += 1;
    if (entry.amount < 0) held.out += entry.amount;
    else held.in += entry.amount;
    totals.set(key, held);
  });
  return [...totals.values()].sort((a, b) => a.out - b.out || b.count - a.count);
}

function renderTally() {
  const wrap = $("money-tally");
  if (!wrap) return;

  const rows = categoryTally();
  if (rows.length === 0) {
    wrap.replaceChildren();
    return;
  }

  wrap.replaceChildren(el("ul", { class: "tally" }, rows.map((row) => el(
    "li",
    { class: `tally-row${row.category === "other" ? " is-loose" : ""}` },
    el("span", { class: "tally-name", text: row.category }),
    el("span", { class: "tally-count", text: `${row.count}` }),
    el("span", { class: "tally-sum", text: zloty(row.out || row.in) })
  ))));
}

function renderRules() {
  const field = $("money-rules");
  if (!field) return;
  field.value = rulesText();
  renderTally();

  const loose = liveTransactions().filter((entry) => (entry.category || "other") === "other").length;
  const status = $("money-rules-status");
  if (!status) return;
  if (liveTransactions().length === 0) {
    status.textContent = "";
    return;
  }
  status.textContent = loose === 0
    ? "Everything has a category."
    : `${loose} ${loose === 1 ? "transaction has" : "transactions have"} no rule yet.`;
  status.classList.toggle("is-stale", loose > 0);
}

function setupRules() {
  $("money-rules-save").addEventListener("click", () => {
    writeStore(MONEY_RULES_KEY, $("money-rules").value);
    touchMoneySettings();
    const changed = recategorise();
    moneyChanged();
    announce(changed === 0
      ? "Rules saved. Nothing changed category."
      : `Rules saved. ${changed} ${changed === 1 ? "transaction" : "transactions"} recategorised.`);
  });

  $("money-rules-reset").addEventListener("click", () => {
    if (!window.confirm("Put the default rules back? Anything you have written here will be lost.")) return;
    writeStore(MONEY_RULES_KEY, DEFAULT_RULES);
    touchMoneySettings();
    recategorise();
    moneyChanged();
    announce("Default rules restored.");
  });
}

/* ---------- Pasting instead of picking a file ---------- */

/*
  A downloaded .csv is awkward to get at on an iPad -- Files will not preview
  it, and the share sheet has nowhere useful to send it. Pasting the contents
  takes the same path and avoids the whole business.
*/
function setupPaste() {
  $("money-paste-open").addEventListener("click", () => {
    const box = $("money-paste");
    box.hidden = !box.hidden;
    if (!box.hidden) $("money-paste-text").focus();
  });

  $("money-paste-import").addEventListener("click", () => {
    const text = $("money-paste-text").value;
    if (!text.trim()) {
      setMoneyStatus("There is nothing pasted yet.", true);
      return;
    }
    importCsvText(text, { label: "what you pasted" }).then((result) => {
      if (result) {
        $("money-paste-text").value = "";
        $("money-paste").hidden = true;
      }
    });
  });
}

/* ---------- Budgets ---------- */

const MONEY_BUDGETS_KEY = "remembre.moneybudgets.v1";

const DEFAULT_BUDGETS = `# A limit per month, in złoty. Leave one out and it is not watched.
food = 600
transport = 120
subscriptions = 80
fun = 150
clothes = 150
`;

/** Same shape as the rules: one line, a name, an equals sign, a number. */
function parseBudgets(text) {
  const budgets = new Map();
  String(text).split(/\r?\n/).forEach((line) => {
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

function budgetsText() {
  const stored = readStore(MONEY_BUDGETS_KEY, null);
  return typeof stored === "string" && stored.trim() ? stored : DEFAULT_BUDGETS;
}

/* ---------- The month ---------- */

const monthOf = (date) => String(date).slice(0, 7);

/** "2026-10" shifted by some months, without a Date going near a time zone. */
function shiftMonth(key, by) {
  const [year, month] = key.split("-").map(Number);
  const total = year * 12 + (month - 1) + by;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

const monthName = (key) => {
  const [year, month] = key.split("-").map(Number);
  return `${["January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December"][month - 1]} ${year}`;
};

/**
 * Everything the report needs for one month. Money in is kept apart from money
 * out: a month with a big transfer in would otherwise look like a month of
 * frugal living.
 */
function monthReport(key) {
  /*
    The month, with the external branch left out of both sides.

    This used to count external spending in the categories and in the month's
    total while the rate and the verdict left it out, so a 300 ticket paid for
    by a 300 wire turned up as a transport overspend on one card and nowhere
    on another. Money from outside the plan is not the month's money, and that
    has to mean the same thing everywhere.
  */
  const entries = liveTransactions().filter((entry) => monthOf(entry.date) === key);
  const out = entries.filter(SPENT_OUT);

  const byCategory = new Map();
  out.forEach((entry) => {
    const name = entry.category || "other";
    byCategory.set(name, (byCategory.get(name) || 0) + entry.amount);
  });

  /*
    Every zloty of the month, on one side or the other, with nothing dropped.

    Three of these used to be invisible: money from outside the plan, spending
    somebody else covered, and spending taken out of savings were all left out
    of the figures and never added up anywhere else either. Leaving a number
    out of the arithmetic is right; leaving it off the page is how a month
    stops adding up and nobody can say why.
  */
  const sum = (list) => list.reduce((total, entry) => total + entry.amount, 0);
  const all = (test) => entries.filter(test);

  return {
    key,
    count: entries.length,
    spent: sum(out),
    received: sum(all((entry) => entry.amount > 0 && entry.branch !== "external")),
    extra: sum(all((entry) => entry.amount > 0 && entry.branch === "external")),
    fromSavings: sum(all((entry) => entry.amount < 0 && entry.branch === "savings")),
    covered: sum(all((entry) => entry.amount < 0 && entry.branch === "external")),
    transfers: sum(all((entry) => entry.amount < 0 && (entry.category || "other") === "transfers")),
    byCategory,
    biggest: out.slice().sort((a, b) => a.amount - b.amount).slice(0, 5),
  };
}

/*
  A charge is recurring when the same payee has taken a similar amount in two
  or more different months. Similar rather than identical, because a
  subscription's price changes and the exchange rate moves under one billed
  abroad; identical-amount matching would quietly lose exactly the charges
  worth noticing.
*/
function recurringCharges() {
  const groups = new Map();
  liveTransactions()
    .filter((entry) => entry.amount < 0)
    .forEach((entry) => {
      const name = fold(entry.counterparty || entry.title || entry.description).slice(0, 40);
      if (!name) return;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(entry);
    });

  const found = [];
  groups.forEach((entries, name) => {
    const months = new Set(entries.map((entry) => monthOf(entry.date)));
    if (months.size < 2) return;

    const amounts = entries.map((entry) => Math.abs(entry.amount)).sort((a, b) => a - b);
    const typical = amounts[Math.floor(amounts.length / 2)];
    const steady = amounts.every((amount) => Math.abs(amount - typical) <= typical * 0.15);
    if (!steady) return;

    found.push({
      name: entries[0].counterparty || entries[0].title,
      category: entries[0].category || "other",
      typical,
      months: months.size,
    });
  });

  return found.sort((a, b) => b.typical - a.typical);
}

/* ---------- Showing the month ---------- */

/** Opens on the month the newest transaction is in, not on an empty one. */
function latestMonth() {
  const dates = liveTransactions().map((entry) => entry.date).sort();
  return dates.length ? monthOf(dates[dates.length - 1]) : monthOf(todayISO());
}

/*
  Every zloty of the month, on one side or the other.

  The figure above this is what the month cost against its own budget, which
  deliberately leaves three things out: money that arrived from outside the
  plan, spending somebody else covered, and spending taken out of savings.
  Leaving them out of that figure is right. Leaving them off the page was not,
  and it is how a month stops adding up with nobody able to say where the
  difference went. So everything is listed, with what is and is not counted
  said plainly.
*/
function ledger(now) {
  const rows = [
    ["In, on the plan", now.received, "counted"],
    ["In, from outside it", now.extra, "apart"],
    ["Out, against the month", now.spent, "counted"],
    ["Out, from savings", now.fromSavings, "apart"],
    ["Out, covered by someone else", now.covered, "apart"],
    ["Moved between your own accounts", now.transfers, "apart"],
  ].filter(([, amount]) => amount !== 0);

  return el(
    "ul",
    { class: "ledger" },
    rows.map(([label, amount, how]) => el(
      "li",
      { class: `ledger-row is-${how}` },
      el("span", { class: "ledger-what", text: label }),
      el("span", { class: "ledger-sum", text: zloty(amount) }),
      el("span", { class: "ledger-how", text: how === "counted" ? "in the month" : "kept apart" })
    ))
  );
}

function renderReport() {
  const wrap = $("money-report");
  if (!wrap) return;

  if (!state.moneyMonth) state.moneyMonth = latestMonth();
  const now = monthReport(state.moneyMonth);
  const before = monthReport(shiftMonth(state.moneyMonth, -1));
  const budgets = parseBudgets(budgetsText());

  $("money-month").textContent = monthName(state.moneyMonth);

  if (now.count === 0) {
    wrap.replaceChildren(el("p", { class: "empty", text: "Nothing in this month." }));
    return;
  }

  const pieces = [];

  pieces.push(el(
    "p",
    { class: "report-total" },
    el("strong", { text: zloty(now.spent) }),
    el("span", { class: "report-against", text: describeChange(now.spent, before.spent, before.key) })
  ));

  pieces.push(ledger(now));

  // Categories, biggest spend first, with last month beside each and a bar
  // where a budget says what the month is allowed to be.
  const names = [...new Set([...now.byCategory.keys(), ...before.byCategory.keys()])]
    .sort((a, b) => (now.byCategory.get(a) || 0) - (now.byCategory.get(b) || 0));

  pieces.push(el("ul", { class: "report-list" }, names.map((name) => {
    const spent = Math.abs(now.byCategory.get(name) || 0);
    const was = Math.abs(before.byCategory.get(name) || 0);
    const limit = budgets.get(name) || 0;
    const share = limit ? Math.min(1, spent / limit) : 0;
    const state_ = !limit ? "" : spent >= limit ? " is-over" : spent >= limit * 0.8 ? " is-close" : "";

    return el(
      "li",
      { class: `report-row${state_}` },
      el("span", { class: "report-name", text: name }),
      el("span", { class: "report-now", text: zloty(-spent) }),
      el("span", { class: "report-was", text: was ? `was ${zloty(-was)}` : "new" }),
      limit
        ? el(
            "span",
            { class: "report-budget" },
            el("span", { class: "report-bar" }, el("span", {
              class: "report-bar-fill", style: `width:${Math.round(share * 100)}%`,
            })),
            el("span", {
              class: "report-limit",
              text: spent >= limit
                ? `${zloty(spent - limit)} over ${zloty(limit)}`
                : `${zloty(limit - spent)} left of ${zloty(limit)}`,
            })
          )
        : null
    );
  })));

  if (now.biggest.length) {
    pieces.push(el("h3", { class: "report-sub", text: "Biggest this month" }));
    pieces.push(el("ul", { class: "tx-list" }, now.biggest.map((entry) => txRow(entry))));
  }

  const repeats = recurringCharges();
  if (repeats.length) {
    pieces.push(el("h3", { class: "report-sub", text: "Looks like it comes every month" }));
    pieces.push(el("ul", { class: "report-list" }, repeats.map((charge) => el(
      "li",
      { class: "report-row" },
      el("span", { class: "report-name", text: charge.name }),
      el("span", { class: "report-now", text: zloty(-charge.typical) }),
      el("span", { class: "report-was", text: `seen in ${charge.months} months` })
    ))));
  }

  wrap.replaceChildren(...pieces);
}

/** "187,20 zł more than September" -- a number alone says nothing. */
function describeChange(spent, was, beforeKey) {
  if (!was) return `nothing to compare with ${monthName(beforeKey).split(" ")[0]}`;
  const difference = Math.abs(spent) - Math.abs(was);
  const month = monthName(beforeKey).split(" ")[0];
  if (difference === 0) return `exactly what you spent in ${month}`;
  return `${zloty(Math.abs(difference))} ${difference > 0 ? "more" : "less"} than ${month}`;
}

function setupReport() {
  $("money-prev").addEventListener("click", () => {
    state.moneyMonth = shiftMonth(state.moneyMonth || latestMonth(), -1);
    renderReport();
    renderCategoryBars();
  });
  $("money-next").addEventListener("click", () => {
    state.moneyMonth = shiftMonth(state.moneyMonth || latestMonth(), 1);
    renderReport();
    renderCategoryBars();
  });
  $("money-income").value = incomePlanText();
  $("money-income-save").addEventListener("click", () => {
    writeStore(MONEY_INCOME_KEY, $("money-income").value);
    touchMoneySettings();
    // A changed schedule re-opens every question it used to answer.
    state.transactions.forEach((entry) => {
      if (entry.amount > 0 && entry.branch === "plan") entry.branch = "";
    });
    saveTransactions();
    moneyChanged();
    announce(`Income plan saved. ${zloty(plannedMonthly())} a month.`);
  });

  $("money-budgets").value = budgetsText();
  $("money-budgets-save").addEventListener("click", () => {
    writeStore(MONEY_BUDGETS_KEY, $("money-budgets").value);
    touchMoneySettings();
    renderReport();
    renderDashboard();
    announce("Budgets saved.");
  });
}

/* ---------- The bank itself ---------- */

/*
  Connecting is a round trip through mBank, so it cannot be done quietly in the
  background: the reader leaves the page, approves, and comes back to
  /?bank=connected. Everything here is read-only -- the server has no endpoint
  that could move money, and a test fails the build if one ever appears.

  The sync phrase is what identifies the vault to the server, exactly as it
  does for syncing. It is sent over HTTPS to a route that immediately hashes
  it, and is never stored server-side.
*/

let bankNote = "";

function bankPhrase() {
  const { enabled, code } = cloudState();
  return enabled && code ? code : "";
}

async function bankCall(action, { method = "POST" } = {}) {
  const code = bankPhrase();
  if (!code) throw new Error("Turn on automatic syncing first: that phrase is what tells the server whose this is.");

  const res = await fetch(`/api/bank?action=${action}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
    cache: "no-store",
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.message) || `The server answered ${res.status}.`);
  return body;
}

function renderBank(connection) {
  const status = $("bank-status");
  if (!status) return;

  // The balance travels with the status, so this is where it is picked up,
  // and the connection itself is what the dashboard's line is drawn from.
  bankBalance = (connection && connection.balance) || bankBalance;
  bankConnection = connection && connection.connected ? connection : null;
  if (typeof renderBalanceCard === "function") renderBalanceCard();

  const connect = $("bank-connect");
  const fetchNow = $("bank-fetch");

  if (!bankPhrase()) {
    status.textContent = "Turn on automatic syncing first. The server needs to know whose account this is. "
      + "It is in Schoolwork, in the sidebar, under Automatic sync.";
    status.classList.add("is-stale");
    connect.disabled = true;
    fetchNow.hidden = true;
    return;
  }
  connect.disabled = false;

  if (bankNote) {
    status.textContent = bankNote;
    status.classList.add("is-stale");
    return;
  }

  if (!connection || !connection.connected) {
    status.textContent = "Not connected. Transactions come in by CSV until you connect.";
    status.classList.remove("is-stale");
    connect.textContent = "Connect mBank";
    fetchNow.hidden = true;
    return;
  }

  const accounts = connection.accounts.map((a) => `${a.name}${a.iban ? ` ${a.iban}` : ""}`).join(", ");
  if (connection.expired) {
    status.textContent = `${accounts}. mBank wants you to approve again.`;
    status.classList.add("is-stale");
  } else if (bankChecking) {
    status.textContent = `${accounts}. Asking mBank for anything new…`;
    status.classList.remove("is-stale");
  } else {
    const until = connection.validUntil ? connection.validUntil.slice(0, 10) : "";
    status.textContent = `Connected to ${accounts}${until ? `, approved until ${until}` : ""}.`;
    status.classList.remove("is-stale");
  }
  connect.textContent = "Connect again";
  fetchNow.hidden = false;
}

async function refreshBank() {
  if (!bankPhrase()) {
    renderBank(null);
    return null;
  }
  try {
    const connection = await bankCall("status");
    bankNote = "";
    renderBank(connection);
    return connection;
  } catch (err) {
    bankNote = err.message;
    renderBank(null);
    return null;
  }
}

/*
  Asking for it now.

  The half refreshes itself when it is opened, and the schedule brings the
  bank in four times a day besides. Neither of those is any use at the moment
  you have just paid for something and want to see where that leaves you, so
  there is a button, and it does the whole thing rather than part of it: the
  consent, the bank itself, the sync that carries what the bank wrote, and the
  redraw. The cooldown that stops a glance at the app becoming a call to mBank
  does not apply to a button somebody pressed on purpose.
*/
async function refreshMoney() {
  const button = $("money-refresh");
  if (!button || button.disabled) return;

  button.disabled = true;
  button.classList.add("is-turning");
  const label = button.querySelector(".refresh-text");
  const was = label ? label.textContent : "";
  if (label) label.textContent = "Checking\u2026";

  try {
    /* The consent first: the pull below refuses without a live one, and the
       figure it carries is worth having even when the bank will not answer. */
    const connection = await refreshBank();

    if (connection && connection.connected && !connection.expired) {
      await pullBank({ force: true, loud: true });
    } else {
      /* No bank, but the other device may still have imported something. */
      await runCloud(() => cloudPull({ quiet: true }));
      moneyChanged();
      showMoneyNotice(connection && connection.expired
        ? "mBank wants approving again, so nothing new could be fetched. Everything else is up to date."
        : "No bank is connected, so there was nothing to fetch. Everything else is up to date.",
      { tone: "plain" });
    }

    if (typeof runInsight === "function") runInsight();
    if (typeof fetchDebrief === "function") fetchDebrief();
  } catch (err) {
    showMoneyNotice(`Could not refresh: ${err.message}`, { tone: "warn" });
  } finally {
    button.disabled = false;
    button.classList.remove("is-turning");
    if (label) label.textContent = was || "Refresh";
    renderBalanceCard();
  }
}

/*
  Opening the half is the refresh.

  Asking the bank used to be a button, because the schedule is only allowed
  four unattended fetches a day and spending one per visit would have emptied
  the allowance by lunchtime. But that limit is about fetches made while
  nobody is there: with the reader on the page, art. 36(5)(b) puts no cap on
  it at all, and the server already marks those trips as attended. So the
  visit itself can be the fetch, and the numbers are the bank's as of a few
  seconds ago rather than as of the last scheduled run.

  Two guards. One pull at a time, and a cooldown, because on an iPad "opening
  the app" happens several times an hour -- every glance at it, every switch
  back from Safari -- and mBank does not need telling about all of them.
*/

const BANK_ASKED_KEY = "remembre.bankasked.v1";
const BANK_COOLDOWN_MS = 3 * 60 * 1000;

let bankPulling = false;    // A pull in flight, so a second open does not start one.
let bankChecking = false;   // What the status line says while it is happening.

function bankLastAsked() {
  const held = readStore(BANK_ASKED_KEY, null);
  const at = held && held.at ? Date.parse(held.at) : 0;
  return Number.isFinite(at) ? at : 0;
}

/**
 * Asks mBank for anything new and folds it in.
 *
 * Quiet by default: an automatic pull that fails must not throw a notice over
 * a page somebody just opened -- the status line under the balance already
 * says when the bank was last heard from, and that is the honest place for it.
 */
async function pullBank({ force = false, loud = false } = {}) {
  if (bankPulling || !bankPhrase()) return null;
  if (!bankConnection || !bankConnection.connected || bankConnection.expired) return null;
  if (!force && Date.now() - bankLastAsked() < BANK_COOLDOWN_MS) return null;

  bankPulling = true;
  bankChecking = true;
  writeStore(BANK_ASKED_KEY, { at: new Date().toISOString() });
  renderBank(bankConnection);
  const button = $("bank-fetch");
  if (button) button.disabled = true;

  try {
    const result = await bankCall("fetch");
    bankNote = "";
    if (result.balance) bankBalance = result.balance;
    // The server wrote them into the vault, so the way to see them is the
    // same sync that carries everything else.
    await runCloud(() => cloudPull({ quiet: true }));
    bankChecking = false;
    moneyChanged();
    /*
      What the bank actually handed over, not just what was new. "Nothing new"
      reads the same whether the bank sent a month of already-known rows or
      sent nothing at all, and the difference is the whole question on an
      afternoon whose spending has not appeared.
    */
    const waiting = typeof result.pending === "number" && result.pending > 0
      ? ` ${result.pending} of them ${result.pending === 1 ? "is" : "are"} authorised but not booked.`
      : " None of them are unbooked: mBank is only giving what it has settled.";
    const said = result.added === 0
      ? `Nothing new at the bank. It read ${result.read} ${result.read === 1 ? "transaction" : "transactions"} back to ${result.from}, and had them all already.${waiting}`
      : `${result.added} new ${result.added === 1 ? "transaction" : "transactions"} from mBank.${waiting}`;
    if (loud) {
      announce(said);
      showMoneyNotice(said, { tone: result.added === 0 ? "plain" : "good" });
    } else if (result.added > 0) {
      // Worth saying even unasked -- the figures just moved under them.
      announce(said);
    }
    await refreshBank();
    return result;
  } catch (err) {
    bankChecking = false;
    if (loud) {
      bankNote = err.message;
      showMoneyNotice(`mBank would not hand anything over: ${err.message}`, { tone: "warn" });
      renderBank(null);
    } else {
      console.warn("Could not check the bank on opening:", err.message);
      renderBank(bankConnection);
    }
    return null;
  } finally {
    bankPulling = false;
    bankChecking = false;
    const again = $("bank-fetch");
    if (again) again.disabled = false;
  }
}

/*
  Everything that belongs to arriving at the money half, in one place, so that
  arriving at it means the same thing however it happened: chosen from the
  chooser, reloaded, or -- much the commonest -- an installed app resumed from
  the background, which runs no startup code at all and used to leave you
  looking at whatever was on screen when you last put the iPad down.
*/
async function moneyOpened() {
  // Resuming after midnight is much the commonest way to end up looking at
  // yesterday's arithmetic, so the day is checked before anything is drawn.
  if (!moneyDayRolled()) moneyChanged();
  // The consent and the last known balance, which cost the bank nothing.
  await refreshBank();
  // And then the bank itself, if it has not just been asked.
  pullBank();
  if (typeof runInsight === "function") runInsight();
  if (typeof fetchDebrief === "function") fetchDebrief();
}

/*
  Midnight. Nearly every figure on this half is relative to today -- the day's
  limit, what is left of it, the carry from yesterday, the weekend purse -- so
  a page left open overnight is a page of yesterday's arithmetic.
*/
let moneySeenDay = todayISO();

function moneyDayRolled() {
  const today = todayISO();
  if (moneySeenDay === today) return false;
  const was = moneySeenDay;
  moneySeenDay = today;
  // A new month is a new page, not last month's page with one day on it. The
  // month only follows the clock if it was following it already: somebody who
  // had stepped back to look at August is left where they put themselves.
  if (monthOf(was) !== monthOf(today) && state.moneyMonth === monthOf(was)) {
    state.moneyMonth = monthOf(today);
  }
  moneyChanged();
  return true;
}

/*
  What the callback told us, carried back in the address. Read once and then
  cleaned out of the URL, so a reload does not announce a week-old outcome.
*/
const BANK_OUTCOMES = {
  connected: { tone: "good", text: "mBank is connected. Fetching your transactions now." },
  refused: { tone: "warn", text: "mBank was not approved, so nothing is connected. Nothing has changed." },
  expired: { tone: "warn", text: "That took too long and the approval went stale. Tap Connect and go straight through." },
  // Much the commonest way for this to fail, and the old wording sent you to
  // the wrong place: the tick box is on mBank's own consent screen.
  "no-accounts": {
    tone: "warn",
    text: "mBank approved the connection but handed back no account. On mBank's screen there is a list of accounts with tick boxes, and your eKonto has to be ticked before you confirm. Approving the consent alone is not enough.",
  },
  "bad-return": { tone: "warn", text: "mBank sent back something unexpected. Tap Connect and try once more." },
  "no-store": { tone: "warn", text: "The server has no storage attached, so there is nowhere to keep the connection." },
  failed: { tone: "warn", text: "Connecting failed on the way back. Tap Connect and try once more." },
};

const outcomeText = (outcome) => (BANK_OUTCOMES[outcome] || {
  tone: "warn", text: "Something happened connecting to mBank, and it did not finish.",
});

function readBankOutcome() {
  const url = new URL(window.location.href);
  const outcome = url.searchParams.get("bank");
  if (!outcome) return "";
  url.searchParams.delete("bank");
  window.history.replaceState({}, "", url.toString() + url.hash);
  return outcome;
}

function setupBank() {
  if (!$("bank-panel")) return;

  $("bank-connect").addEventListener("click", async () => {
    bankNote = "";
    $("bank-connect").disabled = true;
    try {
      const { url } = await bankCall("connect");
      // Leaving the page is the point: mBank does the approving, not us.
      window.location.href = url;
    } catch (err) {
      bankNote = err.message;
      showMoneyNotice(`Connecting could not even be started: ${err.message}`, { tone: "warn" });
      $("bank-connect").disabled = false;
      renderBank(null);
    }
  });

  $("bank-fetch").addEventListener("click", () => {
    // Asked for by hand: no cooldown, and it says what it found.
    pullBank({ force: true, loud: true });
  });

  const outcome = readBankOutcome();
  if (outcome) {
    const said = outcomeText(outcome);
    announce(said.text);
    showMoneyNotice(said.text, {
      tone: said.tone,
      act: outcome === "connected" ? null : { label: "Try again", go: () => $("bank-connect").click() },
    });
    // Coming back from the bank always lands on the half it concerns.
    setArea("money");
    if (outcome === "connected") {
      refreshBank().then(() => $("bank-fetch").click());
      return;
    }
    bankNote = said.text;
  } else {
    // A message from a previous visit outlives the redirect it arrived on:
    // the explanation is worth more than the moment.
    const held = readStore(MONEY_NOTICE_KEY, null);
    if (held && held.text) showMoneyNotice(held.text, { tone: held.tone, keep: false });
  }

  // Otherwise the panel is drawn from what is known, and the server is asked
  // only when this half is opened -- see setArea.
  renderBank(null);
}

/* ---------- Saying something where it can be seen ---------- */

/*
  announce() writes to a region only a screen reader reads, which is right for
  a running commentary and wrong for the one message that explains why nothing
  happened. Coming back from the bank is exactly that case: the page looks
  identical whether it worked or not, and the explanation was going somewhere
  nobody could see.
*/
const MONEY_NOTICE_KEY = "remembre.moneynotice.v1";

function showMoneyNotice(text, { tone = "plain", act = null, keep = true } = {}) {
  const box = $("money-notice");
  if (!box) return;

  if (!text) {
    box.hidden = true;
    box.replaceChildren();
    if (keep) writeStore(MONEY_NOTICE_KEY, null);
    return;
  }

  box.className = `notice is-${tone}`;
  box.hidden = false;
  show(box, [
    el("p", { class: "notice-text", text }),
    el(
      "div",
      { class: "notice-acts" },
      act ? el("button", { type: "button", class: "btn btn-primary btn-tiny", text: act.label, onclick: act.go }) : null,
      el("button", {
        type: "button",
        class: "link-btn",
        text: "Dismiss",
        onclick: () => showMoneyNotice(""),
      })
    ),
  ]);

  // Kept so a reload does not lose the one explanation there was.
  if (keep) writeStore(MONEY_NOTICE_KEY, { text, tone, at: new Date().toISOString() });
}

/* ---------- Where you stand ---------- */

/*
  A balance is not the sum of what has been imported, and showing it as one is
  how a money app ends up confidently wrong: a CSV reaching back ninety days
  does not know what was in the account ninety days ago.

  So the figure comes from whoever actually knows, in this order:

    1. the bank, via the connection -- live, and the only real answer;
    2. the statement's own closing balance, rolled forward over anything dated
       after it;
    3. nothing. Not a guess, not a sum. The card says so and says what would
       fix it.

  Where it came from is always shown with it, because "1 842,10 zl at the bank"
  and "1 842,10 zl as at 28 September" are different claims.
*/

const MONEY_BALANCE_KEY = "remembre.balance.v1";   // what the last statement closed at
const MONEY_SEEN_KEY = "remembre.balanceseen.v1";  // what it was last time it was looked at

/**
 * The closing balance of a statement, which is a different thing from any one
 * row's balance.
 *
 * mBank writes it twice: once as a "Saldo koncowe" line in the footer, and
 * once as the running balance on the newest row. The footer is authoritative
 * when it is there. Falling back to a row means knowing which end of the file
 * is the newest, so that is read off the dates rather than assumed -- the
 * export is newest-first by default, but the sort is a setting.
 */
function closingBalance(text, rows) {
  const dates = rows.map((row) => row.date).filter(Boolean).sort();
  const newest = dates.length ? dates[dates.length - 1] : "";

  for (const line of String(text).split(/\r?\n/)) {
    const cells = splitRow(line, line.includes(";") ? ";" : ",");
    const label = normaliseHeader(cells[0] || "");
    if (!/^saldo (koncowe|poczatkowe)/.test(label)) continue;
    if (!label.startsWith("saldo koncowe")) continue;

    // The figure is in whichever of the remaining cells is money.
    const amounts = cells.slice(1).map(parseAmount).filter((value) => value !== null);
    if (amounts.length) return { amount: amounts[amounts.length - 1], at: newest, source: "statement" };
  }

  const withBalance = rows.filter((row) => row.balance !== null && row.date);
  if (withBalance.length === 0) return null;

  const first = withBalance[0];
  const last = withBalance[withBalance.length - 1];
  const newestFirst = first.date >= last.date;
  const row = newestFirst ? first : last;
  return { amount: row.balance, at: row.date, source: "statement" };
}

/** Keeps the newer of what is stored and what a fresh import closed at. */
function rememberBalance(found) {
  if (!found || !Number.isFinite(found.amount)) return;
  const held = readStore(MONEY_BALANCE_KEY, null);
  if (held && held.at && found.at && held.at > found.at) return;
  writeStore(MONEY_BALANCE_KEY, { ...found, readAt: new Date().toISOString() });
}

/*
  What the bank last told the server. Set by renderBank, because the status
  call is already being made there and the figure comes back with it.
*/
let bankBalance = null;
let bankConnection = null;

/**
 * The balance, with its provenance. `pending` is what has happened since the
 * figure was true, so a statement from Sunday plus three card payments since
 * still adds up to something honest rather than to something stale.
 */
function balanceNow() {
  if (bankBalance && Number.isFinite(bankBalance.amount)) {
    return {
      amount: bankBalance.amount,
      at: bankBalance.at || "",
      readAt: bankBalance.readAt || "",
      source: "bank",
      pending: 0,
      since: 0,
    };
  }

  const held = readStore(MONEY_BALANCE_KEY, null);
  if (!held || !Number.isFinite(held.amount)) return null;

  const after = liveTransactions().filter((entry) => entry.date > held.at);
  const pending = after.reduce((sum, entry) => sum + entry.amount, 0);

  return {
    amount: held.amount + pending,
    at: held.at || "",
    readAt: held.readAt || "",
    source: "statement",
    pending,
    since: after.length,
  };
}

/**
 * Monitoring, in the only sense that is useful on a device you own: the figure
 * is compared with the one you were shown last time, and the difference is
 * what the card leads with. Nothing is polled; a balance changes when a
 * transaction arrives, and that is already an event here.
 */
function balanceMovement(current) {
  if (!current) return null;
  const seen = readStore(MONEY_SEEN_KEY, null);
  writeStore(MONEY_SEEN_KEY, { amount: current.amount, at: new Date().toISOString() });
  if (!seen || !Number.isFinite(seen.amount) || seen.amount === current.amount) return null;
  return { change: current.amount - seen.amount, when: seen.at || "" };
}

/* ---------- The income plan ---------- */

/*
  Money arrives on a schedule: 700 on the 1st, 600 on the 8th, the 15th and
  the 22nd. 2 500 a month, and that is the figure the month has to fit inside
  -- not the median of what happened to land, which was a guess made because
  nothing better was known.

  Anything else that arrives is external: a wire for a specific thing, and
  the spending it pays for is not part of the cycle either. Both sides are
  left out of the rate and the verdict, because counting a 500 that came in
  for a ticket and the 500 that bought the ticket makes a month look first
  rich and then reckless, and it was neither.

  Nothing is guessed about external money. A payment that does not match the
  schedule is a question, and the question is asked on the page.
*/

const MONEY_INCOME_KEY = "remembre.incomeplan.v1";

const DEFAULT_INCOME_PLAN = `# The day of the month, an equals sign, and how much lands that day.
1 = 700
8 = 600
15 = 600
22 = 600
`;

/** Same shape as the rules and the budgets: a day, an equals sign, an amount. */
function parseIncomePlan(text) {
  const slots = [];
  String(text).split(/\r?\n/).forEach((line) => {
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

function incomePlanText() {
  const stored = readStore(MONEY_INCOME_KEY, null);
  return typeof stored === "string" && stored.trim() ? stored : DEFAULT_INCOME_PLAN;
}

const incomePlan = () => parseIncomePlan(incomePlanText());

/** What a whole month is meant to bring in. */
const plannedMonthly = () => incomePlan().reduce((sum, slot) => sum + slot.amount, 0);

/** The dates this month's instalments are due, in order. */
function slotsFor(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return incomePlan().map((slot) => ({
    ...slot,
    // A plan with a 31st in it still works in February.
    date: `${monthKey}-${String(Math.min(slot.day, lastDay)).padStart(2, "0")}`,
  }));
}

/* How far a payment may miss its day and still be that payment. A transfer
   due on a Saturday turns up on the Monday, and sometimes on the Friday. */
const SLOT_DAYS = 5;
const SLOT_SLACK = 0.02;   // and how far off the amount may be

/**
 * Puts this month's arrivals against this month's slots.
 *
 * Only the ones nobody has ruled on are touched: a decision made on the page
 * is never undone by a later import. Exact amounts are matched first, so a
 * 600 that landed two days late does not steal the slot of the 600 that
 * landed on the day.
 */
function matchIncome(monthKey) {
  const slots = slotsFor(monthKey);
  const arrivals = liveTransactions()
    .filter((entry) => entry.amount > 0 && monthOf(entry.date) === monthKey)
    .sort((a, b) => a.date.localeCompare(b.date));

  const taken = new Set(arrivals.filter((entry) => entry.branch === "plan").map((entry) => entry.id));
  const filled = [];

  slots.forEach((slot) => {
    const already = arrivals.find((entry) => entry.branch === "plan" && near(entry, slot));
    if (already) {
      filled.push({ slot, got: already });
      return;
    }

    const candidates = arrivals
      .filter((entry) => !entry.branch && !taken.has(entry.id) && near(entry, slot))
      .sort((a, b) =>
        Math.abs(a.amount - slot.amount) - Math.abs(b.amount - slot.amount)
        || Math.abs(dayGap(a.date, slot.date)) - Math.abs(dayGap(b.date, slot.date)));

    const got = candidates[0] || null;
    if (got) taken.add(got.id);
    filled.push({ slot, got });
  });

  return filled;
}

const dayGap = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);

const near = (entry, slot) =>
  Math.abs(dayGap(entry.date, slot.date)) <= SLOT_DAYS
  && Math.abs(entry.amount - slot.amount) <= Math.max(100, slot.amount * SLOT_SLACK);

/**
 * Files every payment in, and asks nothing.
 *
 * What matches the schedule is the plan. What does not is external -- noted
 * against what you said was coming, when you said anything. Then whatever
 * each external payment paid for is linked to it, by the same rule and with
 * the same silence.
 */
function classifyIncome() {
  const months = new Set(liveTransactions().filter((entry) => entry.amount > 0).map((entry) => monthOf(entry.date)));
  const now = new Date().toISOString();
  let changed = 0;

  months.forEach((monthKey) => {
    matchIncome(monthKey).forEach(({ got }) => {
      if (!got || got.branch) return;
      got.branch = "plan";
      got.updatedAt = now;
      changed += 1;
    });
  });

  /*
    Everything else came from outside the cycle, which is all that needs
    deciding about it -- but only where there is a cycle. With no schedule set
    there is nothing to be outside of, and calling every payment external
    would empty the month of its income and then wonder where it went.
  */
  if (incomePlan().length === 0) {
    if (changed > 0) saveTransactions();
    return changed;
  }

  const held = expectations();
  let noted = false;
  liveTransactions()
    .filter((entry) => entry.amount > 0 && !entry.branch && !entry.counted)
    .forEach((entry) => {
      entry.branch = "external";
      entry.updatedAt = now;
      changed += 1;

      const expected = expectationFor(entry);
      if (expected) {
        const row = held.find((one) => one.id === expected.id);
        if (row) { row.metBy = entry.id; noted = true; }
      }
    });
  if (noted) saveExpectations(held);

  changed += linkExternalSpending();
  if (changed > 0) saveTransactions();
  return changed;
}

/**
 * Where this month stands against the plan.
 *
 * An instalment that has not arrived is one of two different things, and they
 * were being called the same thing: money still coming, or money that was due
 * and did not turn up. On the 6th of a month whose 1st never landed, "next
 * 700 zl on the 1st" is not a forecast, it is a date in the past wearing the
 * word next. The two are separated here: `next` is the first one still ahead,
 * `late` is everything whose day has gone.
 */
function incomeStanding(monthKey, today = todayISO()) {
  const filled = matchIncome(monthKey);
  const planned = plannedMonthly();
  const arrived = filled.filter((row) => row.got).reduce((sum, row) => sum + row.got.amount, 0);

  const waiting = filled.filter((row) => !row.got).map((row) => row.slot);
  const next = waiting.find((slot) => slot.date >= today) || null;
  const late = waiting.filter((slot) => slot.date < today);

  const external = liveTransactions()
    .filter((entry) => entry.amount > 0 && entry.branch === "external" && monthOf(entry.date) === monthKey)
    .reduce((sum, entry) => sum + entry.amount, 0);

  return { planned, arrived, toCome: planned - arrived, next, late, external, filled };
}

/* ---------- How fast it is going ---------- */

/*
  Spending is money out that left for good. A transfer to your own account has
  not been spent -- it has moved -- and counting it makes a week look twice as
  expensive as it was. Cash withdrawals stay in: the money has left the
  account and where it went afterwards is not something a statement knows.
*/
/*
  Spending that counts against the month: not a transfer between your own
  accounts, not something somebody else's money paid for, and not something
  taken out of savings. The same rule the server uses, in the same words.
*/
const SPENT_OUT = (entry) => entry.amount < 0
  && (entry.category || "other") !== "transfers"
  && entry.branch !== "external"
  && entry.branch !== "savings";

/** Every day in the window, including the ones nothing happened on. */
function dailySpending(days = 28) {
  const dates = liveTransactions().map((entry) => entry.date).filter(Boolean).sort();
  if (dates.length === 0) return { days: [], from: "", to: "" };

  const latest = dates[dates.length - 1];
  const to = latest > todayISO() ? latest : todayISO();
  /*
    Four weeks, but never further back than the data goes. A statement that
    starts three weeks ago has no zero days before it -- it has no days before
    it at all, and counting them as zero would quietly understate the rate by
    a quarter and turn an overspending month into a comfortable one.
  */
  const wanted = shiftISO(to, -(days - 1));
  const from = wanted > dates[0] ? wanted : dates[0];

  const perDay = new Map();
  liveTransactions().filter(SPENT_OUT).forEach((entry) => {
    if (entry.date < from || entry.date > to) return;
    perDay.set(entry.date, (perDay.get(entry.date) || 0) + Math.abs(entry.amount));
  });

  const out = [];
  for (let date = from; date <= to; date = shiftISO(date, 1)) {
    out.push({ date, spent: perDay.get(date) || 0 });
  }
  return { days: out, from, to, latest };
}

/** Plain-date arithmetic. No Date object goes near a time zone here. */
function shiftISO(date, by) {
  const [y, m, d] = String(date).split("-").map(Number);
  const moved = new Date(Date.UTC(y, m - 1, d + by));
  return moved.toISOString().slice(0, 10);
}

/** Weeks of seven days, newest last, so "this week against the three before". */
function weeklySpending(days) {
  const week = (slice) => ({
    from: slice[0].date,
    to: slice[slice.length - 1].date,
    length: slice.length,
    spent: slice.reduce((sum, day) => sum + day.spent, 0),
  });

  // Counted back from the newest day, so "this week" means the last seven days
  // rather than whatever Monday happens to be. A leftover stub at the far end
  // is dropped: a two-day "week" beside three full ones is not a comparison.
  const weeks = [];
  for (let end = days.length; end >= 7; end -= 7) weeks.unshift(week(days.slice(end - 7, end)));
  if (weeks.length === 0 && days.length > 0) weeks.push(week(days));
  return weeks.slice(-4);
}

/**
 * What a month of money coming in looks like. The median of the complete
 * months rather than the mean: one 1 200 zl transfer from a grandparent should
 * not become a monthly income, and one empty month should not erase the rest.
 */
function typicalIncome() {
  const byMonth = new Map();
  liveTransactions().filter((entry) => entry.amount > 0).forEach((entry) => {
    const key = monthOf(entry.date);
    byMonth.set(key, (byMonth.get(key) || 0) + entry.amount);
  });

  const thisMonth = monthOf(todayISO());
  const complete = [...byMonth.entries()].filter(([key]) => key !== thisMonth).map(([, sum]) => sum);
  const pool = complete.length ? complete : [...byMonth.values()];
  if (pool.length === 0) return { typical: 0, months: 0 };

  pool.sort((a, b) => a - b);
  const middle = Math.floor(pool.length / 2);
  const typical = pool.length % 2 ? pool[middle] : Math.round((pool[middle - 1] + pool[middle]) / 2);
  return { typical, months: byMonth.size };
}

/*
  Sustainable has a definition here, and it is not a feeling: it is whether
  this rate of spending, continued for a month, fits inside the money that
  comes in. Below 85% leaves something behind, which is the point of the
  exercise; over 100% is eating the balance.

  The verdict always carries a word and a mark, never only a colour -- the bar
  is the same chart either way.
*/
const DAYS_IN_MONTH = 30.44;

function sustainability() {
  const { days, from, to, latest } = dailySpending(28);
  if (days.length === 0) return { verdict: "unclear", why: "Nothing imported yet." };

  const weeks = weeklySpending(days);
  const spent = days.reduce((sum, day) => sum + day.spent, 0);
  const counted = days.length;
  const perDay = Math.round(spent / counted);
  const lastSeven = days.slice(-7);
  const perDayRecent = Math.round(lastSeven.reduce((sum, day) => sum + day.spent, 0) / lastSeven.length);
  const projected = Math.round(perDay * DAYS_IN_MONTH);

  /*
    The plan is what the month has to fit inside. It is known, so it is used:
    the median of what happened to land was a guess made when nothing better
    was available. External money is not in it, by definition.
  */
  const typical = plannedMonthly() || typicalIncome().typical;
  const months = incomePlan().length ? 0 : typicalIncome().months;
  const balance = balanceNow();
  const cover = perDay > 0 && balance ? Math.floor(balance.amount / perDay) : null;

  let verdict = "unclear";
  let why = "";
  const share = typical > 0 ? projected / typical : 0;

  if (counted < 14) {
    why = `Only ${counted} ${counted === 1 ? "day" : "days"} of data, so this is a guess rather than a rate.`;
  } else if (typical <= 0) {
    why = "No income plan is set, so there is nothing to measure the spending against.";
  } else if (share <= 0.85) {
    verdict = "sustainable";
    why = `At ${zloty(perDay)} a day this month would cost ${zloty(projected)}, against ${zloty(typical)} coming in.`;
  } else if (share <= 1) {
    verdict = "tight";
    why = `At ${zloty(perDay)} a day this month would cost ${zloty(projected)}, almost exactly the ${zloty(typical)} coming in.`;
  } else {
    verdict = "overspending";
    why = `At ${zloty(perDay)} a day this month would cost ${zloty(projected)}, which is ${zloty(projected - typical)} more than comes in.`;
  }

  return {
    verdict, why, perDay, perDayRecent, projected, typical, months,
    share, cover, days, weeks, from, to, latest, counted,
  };
}

const VERDICTS = {
  sustainable: { label: "Sustainable", mark: "✓" },
  tight: { label: "Tight", mark: "!" },
  overspending: { label: "Spending faster than it comes in", mark: "▲" },
  unclear: { label: "Not enough to tell yet", mark: "?" },
};

/* ---------- Money from outside the plan ---------- */

/*
  Nothing here asks about what already happened. A payment that did not land
  on the schedule is external, that is all -- the app files it and moves on,
  because a queue of questions about last Tuesday is work, and work is the
  thing a money app is supposed to be saving you.

  The one thing worth being told in advance is what is *coming*: a wire for a
  trip, a present, a refund. Say so and the money is kept out of the month the
  moment it lands, along with what it pays for.
*/

const MONEY_EXPECTED_KEY = "remembre.expected.v1";

const LINK_DAYS = 21;       // how long after a wire its spending may turn up
const LINK_SLACK = 0.05;    // and how far the amounts may differ
const EXPECT_DAYS = 7;      // how far off its day an expected payment may be

function expectations() {
  const held = readStore(MONEY_EXPECTED_KEY, []);
  return (Array.isArray(held) ? held : []).filter((row) => row && row.id && row.amount > 0);
}

const saveExpectations = (rows) => writeStore(MONEY_EXPECTED_KEY, rows);

function addExpectation({ amount, date, what }) {
  const rows = expectations();
  rows.push({
    id: `x${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    amount: Math.round(amount),
    date: String(date || todayISO()).slice(0, 10),
    what: String(what || "").slice(0, 60),
    metBy: "",
  });
  saveExpectations(rows);
  // It may already have arrived, in which case it is placed at once.
  classifyIncome();
  moneyChanged();
}

function dropExpectation(id) {
  saveExpectations(expectations().filter((row) => row.id !== id));
  moneyChanged();
}

/** The expectation an arrival answers, if any. */
function expectationFor(entry) {
  return expectations().find((row) =>
    !row.metBy
    && Math.abs(dayGap(entry.date, row.date)) <= EXPECT_DAYS
    && Math.abs(entry.amount - row.amount) <= Math.max(100, row.amount * LINK_SLACK)) || null;
}

/** The one payment out that most looks like what this money came in for. */
function spendingFor(income) {
  const until = shiftISO(income.date, LINK_DAYS);
  return liveTransactions()
    .filter((entry) => entry.amount < 0 && !entry.branch && !entry.counted
      && entry.date >= income.date && entry.date <= until
      && Math.abs(Math.abs(entry.amount) - income.amount) <= Math.max(100, income.amount * LINK_SLACK))
    .sort((a, b) =>
      Math.abs(Math.abs(a.amount) - income.amount) - Math.abs(Math.abs(b.amount) - income.amount)
      || a.date.localeCompare(b.date))[0] || null;
}

/**
 * Puts the external money and its spending together, without asking. One
 * payment out per payment in, the closest in amount: a wire for a thing is
 * followed by the thing, and two things are a coincidence rather than a rule.
 */
function linkExternalSpending() {
  const linked = new Set(liveTransactions().map((entry) => entry.linkedTo).filter(Boolean));
  const now = new Date().toISOString();
  let changed = 0;

  liveTransactions()
    .filter((entry) => entry.amount > 0 && entry.branch === "external" && !linked.has(entry.id))
    .forEach((income) => {
      const paidFor = spendingFor(income);
      if (!paidFor) return;
      paidFor.branch = "external";
      paidFor.linkedTo = income.id;
      paidFor.updatedAt = now;
      linked.add(income.id);
      changed += 1;
    });

  return changed;
}

/** Puts a payment back into the month, when the link was the wrong guess. */
function countItAgain(id) {
  const entry = state.transactions.find((held) => held.id === id);
  if (!entry) return;
  entry.branch = "";
  entry.linkedTo = "";
  entry.counted = true;     // and the linker does not take it back
  entry.updatedAt = new Date().toISOString();
  saveTransactions();
  moneyChanged();
  announce("Counted as part of the month again.");
}

/* ---------- The ones worth asking about ---------- */

/*
  A big one-off is a question, not a category.

  Four hundred zloty on a plane ticket is not the same kind of event as four
  hundred zloty of shopping, and the difference is not what it was for: it is
  where the money came from. Out of the month, and the month is wrecked; out of
  what was put by, and the month is fine and the savings are smaller; out of
  somebody else's pocket, and neither is true.

  The app used to have no way to say the middle one. Anything large either
  wrecked the month's figures or had to be called external, which claims
  somebody else paid and is a different and untrue thing. So it is asked, once,
  about anything big enough to matter, and never guessed.
*/

/* A payment is big when it is three days' spending, or 120 zl, whichever is
   more. Below that it is a Tuesday and nobody wants to be asked. */
const BIG_FLOOR = 12000;
const BIG_TIMES = 3;

function bigEnoughToAsk(date = todayISO()) {
  const plan = weekPlan(monthOf(date));
  const rate = plan.spendable ? (isWeekend(date) ? plan.weekend : plan.weekday) : 0;
  return Math.max(BIG_FLOOR, rate * BIG_TIMES);
}

/** Big one-offs this month that nobody has placed yet, newest first. */
function worthAsking(monthKey) {
  return liveTransactions()
    .filter((entry) => entry.amount < 0
      && !entry.branch
      && !entry.counted
      && (entry.category || "other") !== "transfers"
      && monthOf(entry.date) === monthKey
      && Math.abs(entry.amount) >= bigEnoughToAsk(entry.date))
    .sort((a, b) => b.date.localeCompare(a.date) || a.amount - b.amount);
}

function renderAsks() {
  const card = $("money-asks");
  if (!card) return;

  const monthKey = state.moneyMonth || latestMonth();
  const asking = worthAsking(monthKey);
  card.hidden = asking.length === 0;
  if (asking.length === 0) {
    card.replaceChildren();
    return;
  }

  show(card, [
    el("div", { class: "card-head" },
      el("h2", { class: "card-title", text: asking.length === 1 ? "One worth asking about" : `${asking.length} worth asking about` })),
    el("p", { class: "chart-caption", text:
      "Where did the money come from? Nothing here is counted either way until you say." }),
    el("ul", { class: "ask-list" }, asking.map((entry) => el(
      "li",
      { class: "ask-row" },
      el("div", { class: "ask-what" },
        el("span", { class: "ask-sum", text: zloty(entry.amount) }),
        el("span", { class: "ask-who", text: entry.counterparty || entry.title || entry.description || "a payment" }),
        el("span", { class: "ask-when", text: entry.date })),
      el("div", { class: "ask-acts" },
        el("button", {
          type: "button", class: "btn btn-quiet btn-tiny",
          text: "Part of the month",
          onclick: () => moveTransaction(entry.id, ""),
        }),
        el("button", {
          type: "button", class: "btn btn-quiet btn-tiny",
          text: "From savings",
          onclick: () => moveTransaction(entry.id, "savings"),
        }),
        el("button", {
          type: "button", class: "btn btn-quiet btn-tiny",
          text: "Someone else paid",
          onclick: () => moveTransaction(entry.id, "external"),
        }))
    ))),
  ]);
}

/* ---------- What is coming, and what came ---------- */

function renderOutside() {
  const wrap = $("money-outside");
  if (!wrap) return;

  const monthKey = state.moneyMonth || latestMonth();
  const waiting = expectations().filter((row) => !row.metBy);
  const arrived = liveTransactions()
    .filter((entry) => entry.amount > 0 && entry.branch === "external" && monthOf(entry.date) === monthKey)
    .sort((a, b) => b.date.localeCompare(a.date));

  if (waiting.length === 0 && arrived.length === 0) {
    show(wrap, [el("p", { class: "empty", text: "Nothing outside the plan this month." })]);
    return;
  }

  const paidBy = new Map(liveTransactions()
    .filter((entry) => entry.linkedTo)
    .map((entry) => [entry.linkedTo, entry]));

  show(wrap, [
    waiting.length
      ? el("ul", { class: "outside-list" }, waiting.map((row) => el(
          "li",
          { class: "outside-row is-waiting" },
          el("span", { class: "outside-when", text: row.date.slice(5) }),
          el("span", { class: "outside-what", text: row.what || "coming" }),
          el("span", { class: "outside-sum", text: zloty(row.amount) }),
          el("button", {
            type: "button", class: "link-btn", text: "Remove",
            onclick: () => dropExpectation(row.id),
          })
        )))
      : null,
    arrived.length
      ? el("ul", { class: "outside-list" }, arrived.map((entry) => {
          const spent = paidBy.get(entry.id);
          return el(
            "li",
            { class: "outside-row" },
            el("span", { class: "outside-when", text: entry.date.slice(5) }),
            el("span", { class: "outside-what" },
              el("span", { text: entry.counterparty || entry.title || "-" }),
              spent
                ? el("span", { class: "outside-paid", text: `paid for ${spent.counterparty || spent.title || "something"}, ${zloty(spent.amount)}` })
                : el("span", { class: "outside-paid", text: "nothing matched to it yet" })),
            el("span", { class: "outside-sum", text: zloty(entry.amount) }),
            spent
              ? el("button", {
                  type: "button", class: "link-btn", text: "Not that one",
                  onclick: () => countItAgain(spent.id),
                })
              : null
          );
        }))
      : null,
  ]);
}

function setupOutside() {
  const form = $("expect-form");
  if (!form) return;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const amount = parseAmount($("expect-amount").value);
    if (amount === null || amount <= 0) {
      announce("Put in how much is coming.");
      $("expect-amount").focus();
      return;
    }
    addExpectation({
      amount,
      date: $("expect-date").value || todayISO(),
      what: $("expect-what").value,
    });
    form.reset();
    announce("Noted. It will be kept out of the month when it arrives.");
  });
}

/* ---------- Hello ---------- */

/*
  Three bands rather than four. "Good night" on a page somebody has just
  opened reads as a dismissal, and the small hours belong to the evening as
  far as anyone awake in them is concerned.
*/
const MONEY_NAME_KEY = "remembre.name.v1";

function greetingFor(hour) {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 18) return "Good afternoon";
  return "Good evening";
}

function renderGreeting(now = new Date()) {
  const wrap = $("money-greeting");
  if (!wrap) return;

  const name = String(readStore(MONEY_NAME_KEY, "") || "Wojciech").slice(0, 40);
  const when = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

  show(wrap, [
    el("h2", { class: "greeting-hello" },
      el("span", { text: `${greetingFor(now.getHours())}, ` }),
      el("span", { class: "greeting-name", text: name })),
    el("p", { class: "greeting-when", text: when }),
    el("p", { class: "greeting-brief", text: briefNow(now) }),
  ]);
}

/*
  The line under the greeting, which has to be there the instant the page
  opens -- before any request, on a train with no signal, on the first ever
  launch. So it is worked out here, from the numbers already on the device,
  and the analysis replaces it with something better when it has read the
  month. A brief that is sometimes absent is not a brief.
*/
function briefNow(now = new Date()) {
  /*
    Friday is a different question from the rest of the week, and it is the
    one that was asked for: what did the week put by. It is worked out here
    rather than by the analysis, because it has to be right to the grosz and
    it has to be there whether or not anything has been read.
  */
  const day = now.getDay();
  if (day === 5 || day === 6 || day === 0) return weekendBrief(now);

  const held = insightCache();
  if (held && held.result && held.result.brief) return String(held.result.brief);
  return localBrief();
}

/** Friday: what you saved. Saturday and Sunday: what is left of it. */
function weekendBrief(now = new Date()) {
  if (liveTransactions().length === 0) return localBrief();

  const purse = weekendPurse(now);
  const day = now.getDay();

  if (day === 5) {
    if (purse.counted === 0) return localBrief();
    if (purse.saved > 0) {
      return `You kept ${zloty(purse.saved)} back this week, so the weekend has ${zloty(purse.purse)}.`;
    }
    if (purse.saved < 0) {
      return `The week ran ${zloty(Math.abs(purse.saved))} over, so the weekend has ${zloty(purse.purse)} rather than ${zloty(purse.base)}.`;
    }
    return `The week came out even, so the weekend has its usual ${zloty(purse.base)}.`;
  }

  if (purse.left >= 0) return `${zloty(purse.left)} left of the weekend's ${zloty(purse.purse)}.`;
  return `The weekend is ${zloty(Math.abs(purse.left))} past its ${zloty(purse.purse)}.`;
}

function localBrief() {
  if (liveTransactions().length === 0) return "Nothing imported yet, so there is nothing to say.";

  const monthKey = state.moneyMonth || latestMonth();
  const month = monthReport(monthKey);
  const read = sustainability();
  const standing = incomeStanding(monthKey);
  const net = month.received + month.spent;

  if (read.verdict === "overspending") {
    return `At ${zloty(read.perDay)} a day this month is heading for ${zloty(read.projected)}, which is more than comes in.`;
  }
  if (net > 0 && standing.toCome <= 0) {
    return `You have put aside ${zloty(net)} this month, with everything in.`;
  }
  if (read.verdict === "sustainable") {
    return `${zloty(read.perDay)} a day so far, which leaves ${zloty(standing.planned - read.projected)} of the plan at this rate.`;
  }
  if (standing.toCome > 0) {
    return `${zloty(standing.arrived)} of your ${zloty(standing.planned)} has arrived, ${zloty(Math.abs(month.spent))} spent.`;
  }
  return `${zloty(Math.abs(month.spent))} out and ${zloty(month.received)} in so far this month.`;
}

/* ---------- The budget map ---------- */

/*
  One picture of where 2 500 is meant to go, drawn the way the reader asked
  for it: the plan on the left, the budgets fanning out of it, each one
  partly filled by what has actually been spent.

  It is laid out in real pixels from the measured width rather than drawn once
  into a viewBox and scaled, because scaled text at phone width is unreadable
  -- the labels have to stay 12px whatever the screen is doing.

  The ramp is the same one hue the category bars use: bigger budget, brighter
  node. Every node carries its name and its two figures, so the colour is
  decoration and the number is the data.
*/

const MAP_NODE_W = 11;
const MAP_GAP = 7;
const MAP_PAD = 6;

function budgetRows(monthKey) {
  const budgets = parseBudgets(budgetsText());
  const month = monthReport(monthKey);

  const rows = [...budgets.entries()].map(([name, limit]) => ({
    name,
    limit,
    spent: Math.abs(month.byCategory.get(name) || 0),
  }));

  // Spending with no budget at all is not invisible: it is the thing a plan
  // most needs to know about, so it arrives as one node of its own.
  const loose = [...month.byCategory.entries()]
    .filter(([name, sum]) => sum < 0 && name !== "transfers" && !budgets.has(name))
    .reduce((sum, [, value]) => sum + Math.abs(value), 0);
  if (loose > 0) rows.push({ name: "not budgeted", limit: 0, spent: loose, loose: true });

  rows.sort((a, b) => (b.limit || b.spent) - (a.limit || a.spent));
  return rows;
}

function renderBudgetMap() {
  const wrap = $("money-map");
  if (!wrap) return;

  const monthKey = state.moneyMonth || latestMonth();
  const rows = budgetRows(monthKey);
  const planned = plannedMonthly();

  if (rows.length === 0) {
    show(wrap, [el("p", {
      class: "empty",
      text: "No budgets yet, so there is nothing to map. Set them in the fold below, or let the analysis propose a set.",
    })]);
    return;
  }

  const allocated = rows.reduce((sum, row) => sum + row.limit, 0);
  const spare = planned - allocated;
  if (spare > 0) rows.push({ name: "unallocated", limit: spare, spent: 0, spare: true });

  const width = Math.max(300, wrap.clientWidth || 640);
  const labelW = width < 520 ? Math.round(width * 0.54) : Math.round(width * 0.42);
  const flowW = Math.max(40, width - labelW - MAP_NODE_W * 2 - MAP_PAD * 2);

  /*
    Every row has two lines of text in it, so no row may be shorter than they
    are however small its budget. The floor is given out first and what is
    left over is shared by value -- strict proportionality would draw a 30 zl
    subscription as a two-pixel sliver with four lines of type piled on top of
    it, which is what it did.
  */
  const value = (row) => Math.max(row.limit, row.spent);
  const total = rows.reduce((sum, row) => sum + value(row), 0) || 1;
  const floor = width < 520 ? 34 : 36;
  /* A phone gets a shorter map: the same picture, not the same pixels. */
  const room = width < 520 ? 300 : 420;
  const slack = Math.max(0, room - rows.length * floor);
  const heights = rows.map((row) => Math.round(floor + (value(row) / total) * slack));

  /*
    The same thought as the colour ramp below, applied to height. Money not
    yet given a job is usually the largest row there is, and drawn to scale it
    becomes the tallest band on the page: the absence of a decision, taking up
    more room than every decision made. It is capped at the tallest real
    budget, so it is still visibly the biggest without being the subject.
  */
  const real = rows.map((row, i) => (row.spare ? 0 : heights[i]));
  const tallestReal = Math.max(floor, ...real);
  rows.forEach((row, i) => {
    if (row.spare) heights[i] = Math.min(heights[i], tallestReal);
  });

  const height = heights.reduce((sum, h) => sum + h, 0) + MAG_GAPS(rows.length) + MAP_PAD * 2;

  /*
    The ramp is scaled over the real budgets only. What is left unallocated is
    usually the largest block of all, and letting it set the top of the scale
    pushed every actual budget into the two dimmest steps -- a chart whose
    brightest colour is reserved for the absence of a decision.
  */
  const biggest = Math.max(...rows.filter((row) => !row.spare).map(value));

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "budget-map");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", mapDescription(rows, planned, monthKey));

  const node = (name, attrs) => {
    const made = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.entries(attrs).forEach(([key, value]) => made.setAttribute(key, String(value)));
    return made;
  };

  /*
    The source is as tall as everything leaving it, and each ribbon is the
    same height at both ends. A flow that narrows on the way across is a
    picture of money going missing.
  */
  const sourceH = heights.reduce((sum, h) => sum + h, 0);
  svg.append(node("rect", {
    class: "map-node map-source", x: 0, y: MAP_PAD,
    width: MAP_NODE_W, height: sourceH, rx: 4,
  }));

  let y = MAP_PAD;
  let sourceAt = MAP_PAD;

  rows.forEach((row, index) => {
    const h = heights[index];
    const x = MAP_NODE_W + flowW + MAP_PAD;
    const step = row.spare ? 0 : seqStep(value(row), biggest);
    const hue = row.spare ? "var(--surface-3)" : `var(--seq-${step})`;

    const c = MAP_NODE_W + flowW * 0.5;
    svg.append(node("path", {
      class: "map-flow",
      d: `M${MAP_NODE_W},${sourceAt} C${c},${sourceAt} ${c},${y} ${x - MAP_PAD},${y}`
        + ` L${x - MAP_PAD},${y + h} C${c},${y + h} ${c},${sourceAt + h} ${MAP_NODE_W},${sourceAt + h} Z`,
      fill: hue,
    }));

    // The node is the budget; the part of it that is filled is what has gone.
    // One hue at two intensities, so "how much is left" is read at a glance
    // without a second colour meaning a second thing.
    svg.append(node("rect", {
      class: "map-node", x, y, width: MAP_NODE_W, height: h, rx: 4,
      fill: hue, "fill-opacity": row.spare ? 1 : 0.3,
    }));

    if (row.spent > 0 && !row.spare) {
      const eaten = Math.max(3, Math.round(Math.min(1, row.spent / value(row)) * h));
      svg.append(node("rect", {
        class: "map-node", x, y: y + h - eaten, width: MAP_NODE_W, height: eaten, rx: 4,
        // Over its limit, or never given one: both are the same news.
        fill: row.loose || (row.limit && row.spent > row.limit) ? "var(--danger)" : hue,
      }));
    }

    // append() hands back nothing, so the text goes on before it goes in.
    const textX = x + MAP_NODE_W + 10;
    const middle = y + h / 2;
    const name = node("text", { class: "map-label", x: textX, y: middle - 3 });
    name.textContent = row.name;

    const line = node("text", { class: `map-sub${noteTone(row)}`, x: textX, y: middle + 12 });
    line.textContent = mapFigures(row, width < 520);
    svg.append(name, line);

    y += h + MAP_GAP;
    sourceAt += h;
  });

  show(wrap, [
    svg,
    el("div", { class: "map-legend" },
      el("span", { class: "map-key" }, el("span", { class: "map-key-mark is-budget" }), el("span", { text: "budget" })),
      el("span", { class: "map-key" }, el("span", { class: "map-key-mark is-spent" }), el("span", { text: "spent so far" })),
      el("span", { class: "map-key" }, el("span", { text: `plan ${zloty(planned)}` }))),
    renderMoves(),
    el(
      "details",
      { class: "as-table" },
      el("summary", { text: "The same map as a table" }),
      el("table", { class: "plain-table" },
        el("thead", {}, el("tr", {},
          el("th", { scope: "col", text: "Category" }),
          el("th", { scope: "col", text: "Budget" }),
          el("th", { scope: "col", text: "Spent" }),
          el("th", { scope: "col", text: "Left" }))),
        el("tbody", {}, rows.map((row) => el("tr", {},
          el("th", { scope: "row", text: row.name }),
          el("td", { text: row.limit ? zloty(row.limit) : "-" }),
          el("td", { text: row.spent ? zloty(-row.spent) : "-" }),
          el("td", { text: row.limit ? zloty(row.limit - row.spent) : "-" })))))
    ),
  ]);
}

/** The gaps between the nodes, which do not get to be part of the data. */
const MAG_GAPS = (count) => Math.max(0, count - 1) * MAP_GAP;

function noteTone(row) {
  if (row.loose) return " is-over";
  if (!row.limit) return "";
  if (row.spent >= row.limit) return " is-over";
  if (row.spent >= row.limit * 0.8) return " is-close";
  return "";
}

/*
  On a phone the grosze are what runs off the edge of the card, and they are
  also the least of what the line is saying. Whole zloty on a narrow screen,
  to the grosz on a wide one.
*/
function mapFigures(row, compact = false) {
  const money = (grosze) => (compact ? `${Math.round(grosze / 100)} zł` : zloty(grosze));
  if (row.spare) return `${money(row.limit)} not given a job`;
  if (row.loose) return `${money(row.spent)} spent, no budget`;
  const over = row.spent >= row.limit;
  const rest = Math.abs(row.limit - row.spent);
  return `${money(row.spent)} of ${money(row.limit)} · ${money(rest)} ${over ? "over" : "left"}`;
}

function mapDescription(rows, planned, monthKey) {
  const parts = rows.slice(0, 6).map((row) => `${row.name} ${zl(row.limit)} zloty, ${zl(row.spent)} spent`);
  return `How ${zl(planned)} zloty of plan is divided in ${monthName(monthKey)}: ${parts.join("; ")}.`;
}

/* ---------- One transaction, up close ---------- */

/*
  The biggest single payments in a month are usually the ones somebody else
  was covering, and a day-to-day budget with a 300 ticket sitting in it is a
  budget that reads wrong all month. The rules cannot know which is which --
  only the person who spent it can -- so every transaction opens, and moving
  it out of the month is one tap.

  Everything done here is marked by hand, and the automatic passes are told to
  leave it alone: the category stays where it was put, and a payment counted
  back into the month is not quietly taken out again by the linker.
*/

let txReturnFocus = null;

function openTransaction(id, from = null) {
  const dialog = $("tx-dialog");
  const entry = liveTransactions().find((held) => held.id === id);
  if (!dialog || !entry) return;

  txReturnFocus = from;
  renderTransaction(entry);
  openDialog(dialog);
}

function renderTransaction(entry) {
  const wrap = $("tx-detail");
  if (!wrap) return;

  const title = $("tx-dialog-title");
  if (title) title.textContent = entry.counterparty || entry.title || entry.description || "Transaction";

  const external = entry.branch === "external";
  const paidFor = entry.linkedTo
    ? liveTransactions().find((held) => held.id === entry.linkedTo)
    : liveTransactions().find((held) => held.linkedTo === entry.id);

  const facts = [
    ["Amount", zloty(entry.amount)],
    ["When", entry.date],
    entry.booked && entry.booked !== entry.date ? ["Booked", entry.booked] : null,
    entry.title && entry.counterparty ? ["Description", entry.title] : null,
    entry.description ? ["Kind", entry.description] : null,
    ["Where it counts", external
      ? "Outside the plan, left out of the month"
      : entry.amount > 0 ? "Money in, part of the plan" : "In this month's spending"],
    paidFor ? [entry.amount > 0 ? "Paid for" : "Covered by",
      `${paidFor.counterparty || paidFor.title || "-"} · ${zloty(paidFor.amount)}`] : null,
    ["Where it came from", entry.source === "api" ? "mBank, automatically" : "a CSV you imported"],
  ].filter(Boolean);

  show(wrap, [
    el("p", { class: `tx-figure${entry.amount < 0 ? "" : " is-in"}`, text: zloty(entry.amount) }),
    el("dl", { class: "tx-facts" }, facts.flatMap(([label, value]) => [
      el("dt", { text: label }),
      el("dd", { text: value }),
    ])),

    el("label", { class: "field-label", for: "tx-category", text: "Category" }),
    categoryPicker(entry),
    entry.fixed
      ? el("p", { class: "field-hint", text: "Set by hand, so the rules leave it alone." })
      : el("p", { class: "field-hint", text: "Chosen by the rules. Pick another and it stays picked." }),

    el(
      "div",
      { class: "dialog-actions" },
      el("button", {
        type: "button",
        class: external ? "btn btn-quiet" : "btn btn-primary",
        text: external ? "Count it in the month" : "Move it outside the plan",
        onclick: () => {
          moveTransaction(entry.id, external ? "" : "external");
          const again = liveTransactions().find((held) => held.id === entry.id);
          if (again) renderTransaction(again);
        },
      }),
      el("span", { class: "dialog-actions-spacer" }),
      el("button", { type: "button", class: "btn btn-quiet", text: "Done", onclick: () => closeDialog($("tx-dialog")) })
    ),

    el("p", { class: "field-hint", text: external
      ? "Outside the plan, it is in neither the day-to-day budget nor the rate. The 2 500 is untouched by it."
      : "Moving it out takes it off the budget and out of the daily rate, for the one-off that somebody else was covering." }),
  ]);
}

/** Every category the rules or the data know about, plus where this one is. */
function categoryPicker(entry) {
  const names = new Set(parseRules(rulesText()).map((rule) => rule.category));
  liveTransactions().forEach((held) => names.add(held.category || "other"));
  names.add("other");

  const picker = el("select", { class: "input", id: "tx-category" },
    [...names].sort().map((name) => el("option", {
      value: name,
      text: name,
      selected: (entry.category || "other") === name,
    })));

  picker.addEventListener("change", () => {
    setTransactionCategory(entry.id, picker.value);
    const again = liveTransactions().find((held) => held.id === entry.id);
    if (again) renderTransaction(again);
  });
  return picker;
}

function moveTransaction(id, branch) {
  const entry = state.transactions.find((held) => held.id === id);
  if (!entry) return;

  entry.branch = branch;
  entry.updatedAt = new Date().toISOString();
  if (branch === "") {
    // Put back on purpose: the linker must not take it away again.
    entry.counted = true;
    entry.linkedTo = "";
  } else {
    entry.counted = false;
  }

  saveTransactions();
  moneyChanged();
  announce(
    branch === "external" ? "Moved outside the plan: somebody else's money paid for it."
    : branch === "savings" ? "Taken out of savings, not out of the month."
    : "Counted in the month again."
  );
}

function setTransactionCategory(id, category) {
  const entry = state.transactions.find((held) => held.id === id);
  if (!entry) return;
  entry.category = String(category || "other").slice(0, 40);
  entry.fixed = true;
  entry.updatedAt = new Date().toISOString();
  saveTransactions();
  moneyChanged();
  announce(`Filed under ${entry.category}.`);
}

/** One row in any list of transactions, which opens when it is tapped. */
function txRow(entry, { showCategory = true } = {}) {
  const button = el(
    "button",
    {
      type: "button",
      class: `tx-open${entry.branch === "external" ? " is-outside" : ""}`,
      onclick: () => openTransaction(entry.id, button),
    },
    el("span", { class: "tx-date", text: entry.date.slice(5) }),
    el("span", { class: "tx-what" },
      el("span", { class: "tx-title", text: entry.counterparty || entry.title || entry.description || "-" }),
      entry.title && entry.counterparty ? el("span", { class: "tx-note", text: entry.title }) : null),
    el("span", { class: `tx-amount${entry.amount > 0 ? " is-in" : ""}`, text: zloty(entry.amount) }),
    showCategory
      ? el("span", {
          class: `tx-cat${(entry.category || "other") === "other" ? " is-loose" : ""}${entry.branch === "external" ? " is-outside" : ""}`,
          text: entry.branch === "external" ? "outside" : (entry.category || "other"),
        })
      : null
  );
  return el("li", { class: "tx" }, button);
}

function setupTransactionDialog() {
  const dialog = $("tx-dialog");
  if (!dialog) return;
  dialog.addEventListener("close", () => {
    if (txReturnFocus && document.body.contains(txReturnFocus)) txReturnFocus.focus();
    txReturnFocus = null;
  });
}

/* ---------- Weekdays, and what they leave for the weekend ---------- */

/*
  A month's spending money divided evenly over thirty days is a plan nobody
  lives: the week is cheap and Friday night is not, and a budget that pretends
  otherwise is broken by the first ordinary Saturday.

  So the same monthly total is split two ways -- a lower weekday rate and a
  weekend rate worth more -- and the arithmetic closes exactly, because the
  rates are solved against the real count of weekdays and weekend days in the
  month. Nothing is saved or lost by the split; it only moves when the money
  is allowed to be spent. The long-term saving is untouched by construction.

  Then the week's own underspend is carried: every zloty not spent between
  Monday and Thursday is a zloty on top of the weekend, which is the whole
  point of spending less on a Tuesday.
*/

/* What a weekend day may cost against a weekday. Not a round 2: the weekend
   should be worth looking forward to, not a different budget entirely. */
const WEEKEND_RATIO = 1.8;

/*
  What a quiet day leaves behind. Half of it goes to the weekend, a quarter to
  tomorrow, and the last quarter is kept -- that quarter is the cap. Without
  it every underspent day comes straight back as a bigger day later and the
  month saves nothing; with it, being careful on a Tuesday is the only thing
  in the app that actually moves the savings.

  The same split runs in reverse: a loud Tuesday is paid for on Wednesday
  rather than quietly at the end of the month.

  These three numbers are also in api/_budget.js, where the server works out
  whether to interrupt your afternoon. tools/budget-test.mjs runs both over
  the same fixtures and fails if they ever disagree.
*/
const CARRY_WEEKEND = 0.5;
const CARRY_TOMORROW = 0.25;
const CARRY_KEPT = 0.25;

/* How close to a day's limit is close enough to say so. */
const NEARLY = 0.8;

/*
  The weekend begins on Friday, because that is when the money is spent. A
  model where Friday is a weekday and Friday night comes out of the weekend
  is a model that charges the same evening to two different budgets; a model
  where the night out comes out of a Tuesday's allowance is one nobody would
  keep. So: Monday to Thursday is the week, Friday to Sunday is the weekend,
  and the Friday-morning question is asked exactly as the weekend opens.
*/
const isWeekend = (iso) => {
  const day = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return day === 0 || day === 5 || day === 6;
};

/** Monday, as a plain date. The week starts where the spending does. */
function weekStart(iso) {
  const day = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return shiftISO(iso, -((day + 6) % 7));
}

function daysOfMonth(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let weekend = 0;
  for (let day = 1; day <= last; day += 1) {
    if (isWeekend(`${monthKey}-${String(day).padStart(2, "0")}`)) weekend += 1;
  }
  return { total: last, weekend, week: last - weekend };
}

/**
 * The two rates. Spendable is what the budgets add up to -- what you have
 * actually decided may be spent -- falling back to the income plan when no
 * budget has been set yet.
 */
function weekPlan(monthKey = state.moneyMonth || latestMonth()) {
  const budgets = parseBudgets(budgetsText());
  const allocated = [...budgets.values()].reduce((sum, limit) => sum + limit, 0);
  const spendable = allocated > 0 ? allocated : plannedMonthly();
  const days = daysOfMonth(monthKey);

  const weekdayRate = spendable / (days.week + WEEKEND_RATIO * days.weekend);
  return {
    spendable,
    days,
    weekday: Math.round(weekdayRate),
    weekend: Math.round(weekdayRate * WEEKEND_RATIO),
  };
}

/**
 * What this week has put by for the weekend.
 *
 * Only completed weekdays count: today is still being spent, so counting it
 * would promise money that has not been saved yet. On a Friday morning that
 * means Monday to Thursday, which is exactly the question being asked.
 */
function weekendPurse(now = new Date()) {
  const today = toISO(now);
  const monday = weekStart(today);
  const plan = weekPlan(monthOf(today));

  let allowed = 0;
  let spent = 0;
  let counted = 0;

  // Monday to Thursday: the four days whose underspend is the weekend's.
  for (let i = 0; i < 4; i += 1) {
    const date = shiftISO(monday, i);
    if (date >= today) break;              // today is not finished with
    allowed += plan.weekday;
    counted += 1;
    spent += liveTransactions()
      .filter((entry) => SPENT_OUT(entry) && entry.date === date)
      .reduce((sum, entry) => sum + Math.abs(entry.amount), 0);
  }

  const saved = allowed - spent;
  // Half of it. A quarter went into the days themselves and a quarter is kept.
  const carried = Math.round(saved * CARRY_WEEKEND);
  const base = plan.weekend * 3;

  // What has already gone on the weekend itself, so Saturday knows where it
  // stands rather than only Friday.
  const weekendSoFar = [4, 5, 6]
    .map((i) => shiftISO(monday, i))
    .filter((date) => date <= today)
    .reduce((sum, date) => sum + liveTransactions()
      .filter((entry) => SPENT_OUT(entry) && entry.date === date)
      .reduce((run, entry) => run + Math.abs(entry.amount), 0), 0);

  return {
    plan, monday, counted, allowed, spent, saved, carried, base,
    purse: base + carried,
    left: base + carried - weekendSoFar,
    weekendSoFar,
  };
}

/**
 * What today is allowed, which is its own rate plus a quarter of what
 * yesterday did not spend.
 */
function dayBudget(date = todayISO()) {
  const plan = weekPlan(monthOf(date));
  const base = isWeekend(date) ? plan.weekend : plan.weekday;

  const yesterday = shiftISO(date, -1);
  const yesterdayBase = isWeekend(yesterday) ? plan.weekend : plan.weekday;
  const left = yesterdayBase - spentOnDay(yesterday);
  const carried = Math.round(left * CARRY_TOMORROW);

  const limit = Math.max(0, base + carried);
  const spent = spentOnDay(date);

  return { date, plan, base, carried, limit, spent, left: limit - spent, share: limit > 0 ? spent / limit : 0, yesterdayLeft: left };
}

const spentOnDay = (date) => liveTransactions()
  .filter((entry) => SPENT_OUT(entry) && entry.date === date)
  .reduce((sum, entry) => sum + Math.abs(entry.amount), 0);

/*
  Money that left today and is deliberately not in the figure above it: a
  transfer between your own accounts, something somebody else paid for,
  something taken out of savings. Each is a good reason not to count it
  against the day's limit. None of them is a reason to leave it off the card.
  A day reading zero while two hundred zloty left the account is a card the
  reader is right not to believe.
*/
function setAsideOn(date) {
  const out = liveTransactions()
    .filter((entry) => entry.amount < 0 && entry.date === date && !SPENT_OUT(entry));

  const reason = (entry) => ((entry.category || "other") === "transfers"
    ? "moved between your own accounts"
    : entry.branch === "savings" ? "taken out of savings"
      : "paid for by somebody else");

  const kinds = new Map();
  out.forEach((entry) => {
    const what = reason(entry);
    kinds.set(what, (kinds.get(what) || 0) + 1);
  });

  return {
    entries: out,
    amount: out.reduce((sum, entry) => sum + Math.abs(entry.amount), 0),
    why: [...kinds].map(([what, count]) => (count === 1 ? what : `${count} ${what}`)),
  };
}

/* ---------- The settings, where the server can read them ---------- */

/*
  Three boxes of text the reader owns. They live on the device, and they are
  also pushed with everything else, because the run that decides whether to
  interrupt an afternoon happens on a server that has never seen this
  browser's storage.

  Newer wins, as a whole: these are three text boxes edited one at a time on
  one device, and a field-by-field merge would be machinery standing guard
  over a case that does not arise.
*/

const MONEY_SETTINGS_AT = "remembre.moneysettings.at";

function moneySettings() {
  return {
    budgets: budgetsText(),
    rules: rulesText(),
    income: incomePlanText(),
    updatedAt: readStore(MONEY_SETTINGS_AT, "") || "1970-01-01T00:00:00.000Z",
  };
}

/** Called whenever one of the three is saved, so the push carries the change. */
function touchMoneySettings() {
  writeStore(MONEY_SETTINGS_AT, new Date().toISOString());
  cloudSchedulePush();
}

/** Takes the other device's, when the other device's is newer. */
function adoptMoneySettings(held) {
  if (!held || typeof held !== "object" || !held.updatedAt) return false;
  if (held.updatedAt <= (readStore(MONEY_SETTINGS_AT, "") || "")) return false;

  if (typeof held.budgets === "string") writeStore(MONEY_BUDGETS_KEY, held.budgets);
  if (typeof held.rules === "string") writeStore(MONEY_RULES_KEY, held.rules);
  if (typeof held.income === "string") writeStore(MONEY_INCOME_KEY, held.income);
  writeStore(MONEY_SETTINGS_AT, held.updatedAt);

  const budgets = $("money-budgets");
  if (budgets) budgets.value = budgetsText();
  const rules = $("money-rules");
  if (rules) rules.value = rulesText();
  const income = $("money-income");
  if (income) income.value = incomePlanText();
  return true;
}

/* ---------- The week, read back ---------- */

/*
  Written on the server on a Sunday evening and fetched here, rather than
  generated when the page opens: a notification that says the week is ready
  has to be telling the truth. What arrives is the last few weeks, and the
  newest one is shown.
*/

const MONEY_DEBRIEF_KEY = "remembre.debrief.v1";

function debriefs() {
  const held = readStore(MONEY_DEBRIEF_KEY, []);
  return Array.isArray(held) ? held : [];
}

async function fetchDebrief() {
  const code = bankPhrase();
  if (!code) return;
  try {
    const res = await fetch(`/api/debrief?code=${encodeURIComponent(code)}`, { cache: "no-store" });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || !Array.isArray(body.weeks)) return;
    writeStore(MONEY_DEBRIEF_KEY, body.weeks);
    renderDebrief();
  } catch (err) {
    // The week will still be there next time the page opens.
  }
}

const DEBRIEF_PARTS = [
  ["performance", "How the week went", "is-good"],
  ["kept", "What went well", "is-good"],
  ["curb", "What to curb", "is-cut"],
  ["nextWeek", "One thing for next week", "is-change"],
];

function renderDebrief() {
  const wrap = $("money-debrief");
  if (!wrap) return;

  const held = debriefs();
  const latest = held.length ? held[held.length - 1] : null;
  if (!latest || !latest.result) {
    wrap.hidden = true;
    wrap.replaceChildren();
    return;
  }

  // A fortnight on, last week's debrief is history rather than news.
  const age = Math.round((Date.parse(todayISO()) - Date.parse(latest.sunday)) / 86400000);
  if (!Number.isFinite(age) || age > 13) {
    wrap.hidden = true;
    wrap.replaceChildren();
    return;
  }

  wrap.hidden = false;
  const { result } = latest;

  show(wrap, [
    el("div", { class: "card-head" },
      el("h2", { class: "card-title", text: "Your week" }),
      el("span", { class: "chart-caption", text: `week to ${latest.sunday}` })),
    el("p", { class: "insight-headline", text: String(result.headline || "") }),
    el("div", { class: "reading-grid" }, DEBRIEF_PARTS.map(([key, title, tone]) => {
      const said = String(result[key] || "").trim();
      if (!said) return null;
      return el("div", { class: `reading-part ${tone}` },
        el("h3", { class: "reading-title", text: title }),
        el("p", { class: "reading-text", text: said }));
    }).filter(Boolean)),
    el("p", { class: "chart-caption", text:
      `${zloty(-(latest.spent || 0))} spent against ${zloty(latest.allowed || 0)} allowed.` }),
  ]);
}

/* ---------- What the months have kept ---------- */

/*
  Saved, here, means money that came in and did not go out again. It is not a
  separate account and the app will not pretend it is one: the proof is the
  balance, which is why the two sit on the same page. What this box adds is
  the shape of it -- which months kept something, which did not, and what the
  whole run comes to.

  External money is on neither side of it, as everywhere else: a wire for a
  ticket and the ticket cancel out and belong to neither the income nor the
  saving.
*/

/*
  Where the count starts.

  Months before it are not counted and not shown: what was spent before there
  was a plan to spend it against is history, and a running total that carries
  it forward is a running total that cannot be read. The month this was first
  asked for is remembered, so the figure keeps growing from there rather than
  resetting itself every time the calendar turns over.
*/
const MONEY_SAVED_FROM = "remembre.savedfrom.v1";

function savedFrom() {
  const held = readStore(MONEY_SAVED_FROM, "");
  if (/^\d{4}-\d{2}$/.test(held)) return held;
  const now = monthOf(todayISO());
  writeStore(MONEY_SAVED_FROM, now);
  return now;
}

function savingsByMonth() {
  const from = savedFrom();
  const months = [...new Set(liveTransactions().map((entry) => monthOf(entry.date)))]
    .filter((key) => key >= from)
    .sort();
  return months.map((key) => {
    const month = monthReport(key);
    return {
      key,
      in: month.received,
      out: Math.abs(month.spent),
      saved: month.received + month.spent,
    };
  });
}

function savingsStanding() {
  const months = savingsByMonth();
  const thisMonth = monthOf(todayISO());
  const done = months.filter((row) => row.key !== thisMonth);
  const now = months.find((row) => row.key === thisMonth) || null;

  return {
    from: savedFrom(),
    months,
    done,
    now,
    total: months.reduce((sum, row) => sum + row.saved, 0),
    best: done.slice().sort((a, b) => b.saved - a.saved)[0] || null,
    kept: done.filter((row) => row.saved > 0).length,
  };
}

function renderSaved() {
  const wrap = $("money-saved");
  if (!wrap) return;

  const standing = savingsStanding();
  const since = monthName(standing.from);

  if (standing.months.length === 0) {
    show(wrap, [
      el("p", { class: "card-title", text: "Money saved" }),
      el("p", { class: "saved-figure", text: zloty(0) }),
      el("p", { class: "kpi-note", text: `Counting from ${since}. Nothing in it yet.` }),
    ]);
    return;
  }

  const biggest = Math.max(1, ...standing.months.map((row) => Math.abs(row.saved)));

  /*
    A box headed "money saved" showing a red negative is a box arguing with
    its own title. What a month in deficit has produced is not savings of a
    negative amount: it is nothing saved, and an overspend to name separately.
  */
  const behind = standing.total < 0;

  show(wrap, [
    el("p", { class: "card-title", text: behind ? "Nothing saved yet" : "Money saved" }),
    el("p", { class: `saved-figure${behind ? " is-waiting" : ""}`,
      text: behind ? zloty(0) : zloty(standing.total) }),
    el("p", { class: "kpi-note", text: behind
      ? `Since ${since}, ${zloty(Math.abs(standing.total))} more has gone out than came in. A month that ends with money left is the one that counts here.`
      : standing.done.length === 0
        ? `Since ${since}. A month that ends with money left is a month saved.`
        : `Since ${since}. ${standing.kept} of ${standing.done.length} finished months kept something.` }),

    el("ul", { class: "saved-months" }, standing.months.slice(-6).map((row) => {
      const share = Math.round((Math.abs(row.saved) / biggest) * 100);
      return el(
        "li",
        { class: `saved-month${row.saved < 0 ? " is-negative" : ""}${row.key === monthOf(todayISO()) ? " is-now" : ""}` },
        el("span", { class: "saved-when", text: monthName(row.key).split(" ")[0].slice(0, 3) }),
        el("span", { class: "saved-track" },
          el("span", { class: "saved-fill", style: `width:${Math.max(2, share)}%` })),
        el("span", { class: "saved-sum", text: zloty(row.saved) })
      );
    })),

    standing.best && standing.best.saved > 0
      ? el("p", { class: "chart-caption", text: `Best so far: ${monthName(standing.best.key)}, ${zloty(standing.best.saved)}.` })
      : null,
  ]);
}

/* ---------- The dashboard ---------- */

/*
  The order on this page is the order the questions get asked in: what have I
  got, where did it go, and am I going too fast. History is at the bottom
  behind a fold, because nobody opens a money app to re-read last Tuesday.

  Magnitude is drawn in one hue, light to dark, never a rainbow: a colour here
  means "bigger", and five steps of one colour say that where five different
  colours would only say "different". The steps are in styles.css as --seq-1
  to --seq-5, chosen against this app's own surfaces and checked for contrast
  and for colour-vision separation. Every bar also carries its number, so the
  colour is decoration and the figure is the data.
*/

/** Which of the five steps a value sits on, relative to the biggest one. */
function seqStep(value, biggest) {
  if (!biggest) return 1;
  const share = Math.abs(value) / Math.abs(biggest);
  return Math.min(5, Math.max(1, Math.ceil(share * 5)));
}

const percent = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);

/** "3 days ago", for a figure whose age is the thing worth knowing. */
function ageInWords(iso) {
  if (!iso) return "";
  const days = Math.round((Date.parse(todayISO()) - Date.parse(String(iso).slice(0, 10))) / 86400000);
  if (!Number.isFinite(days)) return "";
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

/*
  ageInWords counts days, which is right for a statement and useless for a
  reading taken forty seconds ago. This one counts from the clock and hands
  over to the other once the hours stop being worth naming.
*/
function freshness(iso) {
  if (!iso) return "";
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(minutes) || minutes < 0) return "";
  if (minutes < 1) return "just now";
  if (minutes === 1) return "a minute ago";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours === 1) return "an hour ago";
  if (hours < 10) return `${hours} hours ago`;
  return ageInWords(iso);
}

/*
  The button that skips the waiting.

  On the balance card rather than in the bar, because the balance is the thing
  it changes and the line underneath already says how old the figure is. It
  says when it last looked rather than only what it does: a refresh button
  that cannot tell you whether it is worth pressing is a button you press out
  of superstition.
*/
function refreshButton() {
  const asked = bankLastAsked();
  const when = asked ? freshness(new Date(asked).toISOString()) : "";

  return el(
    "button",
    {
      type: "button",
      id: "money-refresh",
      class: "btn btn-quiet btn-tiny refresh-btn",
      title: when ? `Last checked ${when}` : "Fetch the newest from mBank",
      onclick: refreshMoney,
    },
    refreshMark(),
    el("span", { class: "refresh-text", text: "Refresh" })
  );
}

/*
  An arrow coming back round to where it started.

  Built with createElementNS rather than through el(), because el() calls
  createElement and an <svg> made that way is an unknown HTML element: it
  parses, it sits in the DOM, and it draws absolutely nothing.
*/
const SVG_NS = "http://www.w3.org/2000/svg";

function refreshMark() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "refresh-mark");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  ["M20.5 12a8.5 8.5 0 1 1-2.49-6.01", "M20.5 4.5V10H15"].forEach((d) => {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
  });

  return svg;
}

function renderBalanceCard() {
  const card = $("money-balance");
  if (!card) return;

  const balance = balanceNow();
  if (!balance) {
    show(card, [
      el("div", { class: "kpi-head" },
        el("p", { class: "kpi-label", text: "Current balance" }),
        refreshButton()),
      el("p", { class: "kpi-figure is-missing", text: "-" }),
      el("p", {
        class: "kpi-note",
        text: "No statement has told us what is in the account yet. Import a CSV, or connect mBank and it arrives on its own.",
      }),
      planLine(state.moneyMonth || latestMonth()),
      bankLine(),
    ]);
    return;
  }

  const movement = balanceMovement(balance);
  const monthKey = state.moneyMonth || latestMonth();
  const month = monthReport(monthKey);
  const when = monthName(monthKey).split(" ")[0];

  const provenance = balance.source === "bank"
    ? `Straight from mBank${balance.readAt ? `, read ${freshness(balance.readAt)}` : ""}.`
    : `From the statement that closed on ${balance.at}${
        balance.since ? `, plus ${balance.since} ${balance.since === 1 ? "transaction" : "transactions"} since (${zloty(balance.pending)})` : ""
      }.`;

  show(card, [
    el("div", { class: "kpi-head" },
      el("p", { class: "kpi-label", text: "Current balance" }),
      refreshButton()),
    el("p", { class: `kpi-figure${balance.amount < 0 ? " is-negative" : ""}`, text: zloty(balance.amount) }),
    movement
      ? el("p", {
          class: `kpi-move${movement.change < 0 ? " is-down" : " is-up"}`,
          text: `${movement.change < 0 ? "↓" : "↑"} ${zloty(Math.abs(movement.change))} since you last looked`,
        })
      : null,
    el("p", { class: "kpi-note", text: provenance }),
    planLine(monthKey),
    bankLine(),
    liquidityNote(),
    el(
      "ul",
      { class: "kpi-strip" },
      el("li", {}, el("span", { class: "strip-label", text: `Spent in ${when}` }),
        el("span", { class: "strip-value", text: zloty(month.spent) })),
      el("li", {}, el("span", { class: "strip-label", text: "Came in" }),
        el("span", { class: "strip-value", text: zloty(month.received) })),
      el("li", {}, el("span", { class: "strip-label", text: "Net" }),
        el("span", {
          class: `strip-value${month.received + month.spent < 0 ? " is-negative" : ""}`,
          text: zloty(month.received + month.spent),
        }))
    ),
  ]);
}

/* replaceChildren prints the word "null" where el() would drop it. */
function show(node, children) {
  node.replaceChildren(...children.filter(Boolean));
}

/*
  The one quotation in the app, and it belongs here or nowhere: this is the
  card about having money rather than about having spent it, and the balance
  is the only figure on the page that is literally liquidity. Anywhere else it
  would be a poster.
*/
function liquidityNote() {
  return el("p", { class: "kpi-quote" },
    el("span", { class: "kpi-quote-said", text: "“No matter what happens, never lose liquidity.”" }),
    el("cite", { class: "kpi-quote-who", text: "Warren Buffett" }));
}

/**
 * Where the month stands against the schedule: what is meant to arrive, what
 * has, and when the next instalment is due. On the card rather than in a
 * setting, because it is the number every other number here is measured
 * against.
 */
function planLine(monthKey) {
  const plan = incomePlan();
  if (plan.length === 0) return null;

  const standing = incomeStanding(monthKey);
  /* Only money that is genuinely still ahead is money to come. */
  const when = standing.next
    ? `, ${zloty(standing.toCome)} to come · next ${zloty(standing.next.amount)} on the ${ordinal(standing.next.day)}`
    : "";
  const outside = standing.external ? `, ${zloty(standing.external)} from outside the plan` : "";

  const owed = standing.late.reduce((sum, slot) => sum + slot.amount, 0);
  const days = standing.late.map((slot) => ordinal(slot.day));
  const over = monthKey < monthOf(todayISO());

  return el("p", { class: "kpi-plan" },
    el("span", { text: `Plan ${zloty(standing.planned)}, ${zloty(standing.arrived)} in${when}${outside}` }),
    standing.late.length > 0
      ? el("span", {
          class: "kpi-late",
          text: `${zloty(owed)} due on the ${inWords(days)} ${over ? "never arrived" : "has not arrived"}.`,
        })
      : null);
}

/** "the 1st", "the 1st and the 8th", "the 1st, the 8th and the 15th". */
function inWords(parts) {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

const ordinal = (n) => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] || "th"}`;
};

/**
 * Whether the bank is connected, said on the page somebody actually looks at.
 *
 * It used to live only in the setup panel, which is now behind a fold -- so
 * "not connected" was indistinguishable from "connected and quiet", which is
 * the one distinction that matters when nothing is arriving.
 */
function bankLine() {
  if (!bankPhrase()) {
    return el("p", { class: "kpi-bank" },
      el("span", { class: "kpi-dot is-off", "aria-hidden": "true" }),
      el("span", { text: "mBank can only be connected once syncing is on. The phrase is what tells the server whose account it is." }),
      el("button", { type: "button", class: "link-btn", text: "Turn syncing on", onclick: openSyncing }));
  }

  if (!bankConnection || !bankConnection.connected) {
    return el("p", { class: "kpi-bank" },
      el("span", { class: "kpi-dot is-off", "aria-hidden": "true" }),
      el("span", { text: "mBank is not connected, so transactions only arrive when you import a CSV." }),
      el("button", {
        type: "button",
        class: "link-btn",
        text: "Connect it",
        onclick: () => { const go = $("bank-connect"); if (go) go.click(); },
      }));
  }

  const where = bankConnection.accounts.map((a) => `${a.name}${a.iban ? ` ${a.iban}` : ""}`).join(", ");
  if (bankConnection.expired) {
    return el("p", { class: "kpi-bank" },
      el("span", { class: "kpi-dot is-stale", "aria-hidden": "true" }),
      el("span", { text: `mBank wants approving again. ${where}.` }),
      el("button", {
        type: "button",
        class: "link-btn",
        text: "Approve again",
        onclick: () => { const go = $("bank-connect"); if (go) go.click(); },
      }));
  }

  if (bankChecking) {
    return el("p", { class: "kpi-bank" },
      el("span", { class: "kpi-dot is-on", "aria-hidden": "true" }),
      el("span", { text: `Asking mBank for anything new. ${where}.` }));
  }

  // lastFetchAt is a moment, fetchedTo only a date: on a half that refreshes
  // itself on opening, "today" is not a useful answer to "when was this read".
  const when = freshness(bankConnection.lastFetchAt) || ageInWords(bankConnection.fetchedTo);
  const checked = when ? `, last checked ${when}` : "";
  return el("p", { class: "kpi-bank" },
    el("span", { class: "kpi-dot is-on", "aria-hidden": "true" }),
    el("span", { text: `mBank connected. ${where}${checked}.` }));
}

/*
  Syncing is set up on the schoolwork side, because that is where it started.
  Being told from here that it is the thing in the way, without being told
  where, is only half an answer -- so this takes you there and puts the cursor
  in the box.
*/
function openSyncing() {
  setArea("school");
  // Settings are folded away, and being sent to a panel inside a shut fold is
  // being sent nowhere: the scroll lands on the summary and the focus is lost.
  const fold = $("settings-fold");
  if (fold) fold.open = true;
  const panel = $("cloud-panel");
  if (!panel) return;
  panel.scrollIntoView({ behavior: "smooth", block: "center" });
  const box = $("cloud-code");
  if (box) box.focus({ preventScroll: true });
}

/*
  What is actually in a category, when one is opened: the payments themselves,
  biggest first, each one a tap away from its own details. A summary by payee
  was the first version of this and it answered the wrong question -- the one
  payment worth moving out of the month is a single row, and a total hides it.
*/
function transactionsIn(category, monthKey) {
  return liveTransactions()
    .filter((entry) => entry.amount < 0
      && (entry.category || "other") === category
      && monthOf(entry.date) === monthKey)
    .sort((a, b) => a.amount - b.amount);
}

function renderCategoryBars() {
  const wrap = $("money-cats");
  if (!wrap) return;

  const monthKey = state.moneyMonth || latestMonth();
  const now = monthReport(monthKey);
  const before = monthReport(shiftMonth(monthKey, -1));
  const budgets = parseBudgets(budgetsText());

  const rows = [...now.byCategory.entries()]
    .filter(([name, sum]) => sum < 0 && name !== "transfers")
    .map(([name, sum]) => ({ name, spent: Math.abs(sum), was: Math.abs(before.byCategory.get(name) || 0) }))
    .sort((a, b) => b.spent - a.spent);

  if (rows.length === 0) {
    wrap.replaceChildren(el("p", { class: "empty", text: "Nothing went out in this month." }));
    return;
  }

  const biggest = rows[0].spent;
  const total = rows.reduce((sum, row) => sum + row.spent, 0);

  show(wrap, [
    el("p", { class: "chart-caption", text: `${zloty(-total)} out across ${rows.length} ${rows.length === 1 ? "category" : "categories"}. Tap one to see where.` }),
    el("ul", { class: "bars" }, rows.map((row) => {
      const limit = budgets.get(row.name) || 0;
      const over = limit && row.spent >= limit;
      const close = limit && !over && row.spent >= limit * 0.8;

      const note = [
        `${percent(row.spent, total)}% of the month`,
        row.was ? `was ${zloty(-row.was)}` : "new this month",
        limit
          ? over
            ? `${zloty(row.spent - limit)} over the ${zloty(limit)} limit`
            : `${zloty(limit - row.spent)} left of ${zloty(limit)}`
          : "",
      ].filter(Boolean).join(", ");

      const detail = el("ul", { class: "bar-detail tx-list", hidden: true });

      const button = el(
        "button",
        {
          type: "button",
          class: "bar-open",
          "aria-expanded": "false",
          onclick: () => {
            const open = button.getAttribute("aria-expanded") === "true";
            button.setAttribute("aria-expanded", open ? "false" : "true");
            detail.hidden = open;
            if (!open) {
              const inside = transactionsIn(row.name, monthKey);
              show(detail, [
                ...inside.slice(0, 12).map((entry) => txRow(entry, { showCategory: false })),
                inside.length > 12
                  ? el("li", { class: "tx-more", text: `and ${inside.length - 12} more, in Every transaction below` })
                  : null,
              ]);
            }
          },
        },
        el("span", { class: "bar-head" },
          el("span", { class: "bar-name", text: row.name }),
          el("span", { class: "bar-value", text: zloty(-row.spent) })),
        el("span", { class: "bar-track" }, el("span", {
          class: `bar-fill seq-${seqStep(row.spent, biggest)}${over ? " is-over" : close ? " is-close" : ""}`,
          style: `width:${Math.max(2, Math.round((row.spent / biggest) * 100))}%`,
        })),
        el("span", { class: `bar-note${over ? " is-over" : close ? " is-close" : ""}`, text: note })
      );

      return el("li", { class: "bar-row" }, button, detail);
    })),
  ]);
}

/*
  Twenty-eight days of columns, with a line across them at what a day is
  allowed to cost if the month is to fit inside the money coming in. The line
  is the point of the chart: a column is only tall or short against something.
*/
/* ---------- The guard, on the page ---------- */

/*
  The same arithmetic the server sends the alert from, drawn where the days
  are. Mirrored rather than imported because this half runs with no build step
  and the server half runs on Node; tools/budget-test.mjs runs both over the
  same fixtures and fails if they ever disagree by a grosz.
*/
const GUARD_WINDOW = 7;
const GUARD_RUN = 2;
const GUARD_WATCH = 1.15;
const GUARD_OVER = 1.35;

function pressureNow(date = todayISO()) {
  const days = [];
  for (let back = GUARD_WINDOW - 1; back >= 0; back -= 1) {
    const when = shiftISO(date, -back);
    const plan = weekPlan(monthOf(when));
    const rate = plan.spendable ? (isWeekend(when) ? plan.weekend : plan.weekday) : 0;
    days.push({ date: when, spent: spentOnDay(when), rate });
  }

  const spent = days.reduce((sum, day) => sum + day.spent, 0);
  const allowed = days.reduce((sum, day) => sum + day.rate, 0);
  const load = allowed > 0 ? spent / allowed : 0;

  let run = 0;
  for (let i = days.length - 1; i >= 0; i -= 1) {
    if (days[i].spent > days[i].rate && days[i].rate > 0) run += 1;
    else break;
  }

  const level = load >= GUARD_OVER || run >= GUARD_RUN + 1 || (run >= GUARD_RUN && load >= GUARD_WATCH)
    ? "over"
    : run >= GUARD_RUN || load >= GUARD_WATCH
      ? "watch"
      : "calm";

  return { days, run, spent, allowed, load, level };
}

/**
 * The guard's line on the card.
 *
 * Deliberately present when it is calm as well. A guard that only appears when
 * it is unhappy is a guard you cannot check, and checking it is what makes it
 * worth believing the one time it speaks up.
 */
function guardLine() {
  const read = pressureNow();
  if (read.allowed <= 0) return null;
  const share = Math.round(read.load * 100);

  const words = read.level === "calm"
    ? read.run === 1
      ? `One day over, and the week at ${share}% of its rate. Nothing in that.`
      : `The last seven days are at ${share}% of their rate.`
    : read.run >= GUARD_RUN
      ? `${read.run} days over in a row, with the week at ${share}% of its rate.`
      : `The week is at ${share}% of its rate, with no single day that looks bad.`;

  return el(
    "p",
    { class: `guard-line is-${read.level}` },
    el("span", { class: "guard-mark", "aria-hidden": "true" }),
    el("span", { text: words })
  );
}

function renderRateCard() {
  const wrap = $("money-rate");
  if (!wrap) return;

  const read = sustainability();
  const verdict = VERDICTS[read.verdict] || VERDICTS.unclear;

  if (!read.days || read.days.length === 0) {
    wrap.replaceChildren(el("p", { class: "empty", text: "Nothing to measure yet." }));
    return;
  }

  const allowance = read.typical > 0 ? Math.round(read.typical / DAYS_IN_MONTH) : 0;
  const tallest = Math.max(allowance, ...read.days.map((day) => day.spent)) || 1;
  const busiest = read.days.reduce((held, day) => (day.spent > held.spent ? day : held), read.days[0]);

  const columns = el("ol", { class: "rate-days" }, read.days.map((day) => {
    const height = Math.round((day.spent / tallest) * 100);
    const weekday = new Date(`${day.date}T12:00:00Z`).getUTCDay();
    return el(
      "li",
      { class: `rate-day${weekday === 0 || weekday === 6 ? " is-weekend" : ""}` },
      el("span", {
        class: `rate-col seq-${seqStep(day.spent, tallest)}`,
        style: `height:${day.spent === 0 ? 0 : Math.max(2, height)}%`,
        title: `${day.date}: ${zloty(-day.spent)}`,
      })
    );
  }));

  const chart = el(
    "div",
    {
      class: "rate-chart",
      role: "img",
      "aria-label": `Daily spending from ${read.from} to ${read.to}. ${zloty(read.perDay)} a day on average` +
        (allowance ? `, against ${zloty(allowance)} a day to stay inside what comes in.` : "."),
    },
    allowance
      ? el("div", { class: "rate-line", style: `bottom:${Math.round((allowance / tallest) * 100)}%` })
      : null,
    columns
  );

  const stale = read.latest && read.latest < shiftISO(todayISO(), -3)
    ? `Nothing newer than ${read.latest} has come in, so the last few days read as zero.`
    : "";

  show(wrap, [
    el(
      "div",
      { class: `verdict is-${read.verdict}` },
      el("span", { class: "verdict-mark", "aria-hidden": "true", text: verdict.mark }),
      el("span", { class: "verdict-words" },
        el("strong", { class: "verdict-label", text: verdict.label }),
        el("span", { class: "verdict-why", text: read.why }))
    ),
    guardLine(),
    el(
      "ul",
      { class: "rate-strip" },
      el("li", {}, el("span", { class: "strip-label", text: "Average day" }),
        el("span", { class: "strip-value", text: zloty(read.perDay) })),
      el("li", {}, el("span", { class: "strip-label", text: "Last seven days" }),
        el("span", { class: "strip-value", text: zloty(read.perDayRecent) })),
      el("li", {}, el("span", { class: "strip-label", text: "At this rate, a month" }),
        el("span", { class: "strip-value", text: zloty(read.projected) })),
      busiest.spent > 0
        ? el("li", {}, el("span", { class: "strip-label", text: `Biggest day (${busiest.date.slice(5)})` }),
            el("span", { class: "strip-value", text: zloty(-busiest.spent) }))
        : null,
      read.cover !== null && read.cover < 400
        ? el("li", {}, el("span", { class: "strip-label", text: "Balance covers" }),
            el("span", { class: "strip-value", text: `${read.cover} days` }))
        : null
    ),
    chart,
    allowance
      ? el("p", { class: "chart-caption rate-key" },
          el("span", { class: "rate-key-mark", "aria-hidden": "true" }),
          el("span", { text: `the dashed line is ${zloty(allowance)} a day, which keeps the month even` }))
      : null,
    el("ul", { class: "weeks" }, read.weeks.map((week) => el(
      "li",
      { class: "week" },
      el("span", { class: "week-when", text: `${week.from.slice(5)} to ${week.to.slice(5)}` }),
      el("span", { class: "week-sum", text: zloty(-week.spent) }),
      el("span", { class: "week-rate", text: `${zloty(Math.round(week.spent / week.length))} a day` })
    ))),
    stale ? el("p", { class: "chart-caption is-stale", text: stale }) : null,
    el(
      "details",
      { class: "as-table" },
      el("summary", { text: "The same numbers as a table" }),
      el("table", { class: "plain-table" },
        el("thead", {}, el("tr", {},
          el("th", { scope: "col", text: "Week" }),
          el("th", { scope: "col", text: "Out" }),
          el("th", { scope: "col", text: "A day" }))),
        el("tbody", {}, read.weeks.map((week) => el("tr", {},
          el("th", { scope: "row", text: `${week.from} to ${week.to}` }),
          el("td", { text: zloty(-week.spent) }),
          el("td", { text: zloty(Math.round(week.spent / week.length)) })))))
    ),
  ]);
}

/**
 * One line for the money tile on the chooser: what is left today, which is
 * the only thing anybody wants to know before deciding whether to look.
 */
function moneyTileLine() {
  if (liveTransactions().length === 0) return "";
  const today = dayBudget();
  if (!today.plan.spendable) return "";
  return today.left < 0
    ? `${zloty(Math.abs(today.left))} over today`
    : `${zloty(today.left)} left today`;
}

/*
  The money half opens on the one number it exists to answer: how much there
  is left to spend today. It used to be a line in the middle of the fourth
  card down, which on a phone meant scrolling past two and a half thousand
  pixels of charts to reach the figure you opened the app for.

  Everything under it is context for it: the rate it came from, what yesterday
  carried in, and what the weekend has waiting.
*/
function renderToday() {
  const wrap = $("money-today");
  if (!wrap) return;

  const today = dayBudget();
  if (!today.plan.spendable) {
    wrap.hidden = true;
    wrap.replaceChildren();
    return;
  }
  wrap.hidden = false;

  const over = today.left < 0;
  const share = Math.max(0, Math.min(1, today.share));
  const tone = over ? " is-over" : today.share >= NEARLY ? " is-close" : "";
  const kind = isWeekend(today.date) ? "weekend day" : "weekday";

  const made = today.carried === 0
    ? `${zloty(today.limit)} for a ${kind}`
    : today.carried > 0
      ? `${zloty(today.base)} for a ${kind}, plus ${zloty(today.carried)} carried from yesterday`
      : `${zloty(today.base)} for a ${kind}, less ${zloty(Math.abs(today.carried))} carried from yesterday`;
  const from = `${zloty(today.spent)} spent of ${zloty(today.limit)} today: ${made}.`;

  /*
    Why the figure can read zero on a day money plainly went out. Either it
    has not been imported yet -- a card payment reaches mBank hours after it
    happens -- or every payment today is one the month deliberately does not
    count. Both are worth saying; neither used to be said at all.
  */
  const aside = setAsideOn(today.date);
  const asked = bankLastAsked();
  const unsettled = liveTransactions()
    .filter((entry) => entry.pending && entry.date === today.date && SPENT_OUT(entry))
    .reduce((sum, entry) => sum + Math.abs(entry.amount), 0);

  const lines = [];
  if (unsettled > 0) {
    lines.push(`${zloty(unsettled)} of that the bank has not booked yet, so it may still move.`);
  }
  if (aside.amount > 0) {
    lines.push(`${zloty(aside.amount)} more left the account today and is not counted: ${aside.why.join(", ")}.`);
  }
  if (lines.length === 0 && today.spent === 0) {
    lines.push(asked
      ? `Nothing has come in for today. The bank was last asked ${freshness(new Date(asked).toISOString())}.`
      : "Nothing has come in for today, and no bank is connected.");
  }
  const note = lines.join(" ");

  show(wrap, [
    el("p", { class: "lead-label", text: over ? "Over today by" : "Left to spend today" }),
    el("p", {
      class: `lead-figure${tone}`,
      text: zloty(Math.abs(today.left)),
    }),
    el(
      "div",
      {
        class: `lead-meter${tone}`,
        role: "img",
        "aria-label": `${zloty(today.spent)} spent of ${zloty(today.limit)} for today.`,
      },
      el("span", { class: "lead-meter-fill", style: `width:${Math.round(share * 100)}%` })
    ),
    el("p", { class: "lead-note", text: from }),
    note ? el("p", { class: "lead-aside", text: note }) : null,
    weekLine(),
  ]);
}

/**
 * The week's two rates and what is riding on them, on the card where the
 * daily figures already live.
 */
function todayLine() {
  const today = dayBudget();
  if (!today.plan.spendable) return null;

  const tone = today.share >= 1 ? " is-over" : today.share >= NEARLY ? " is-close" : "";
  const carried = today.carried === 0 ? ""
    : today.carried > 0
      ? `, ${zloty(today.base)} for a ${isWeekend(today.date) ? "weekend day" : "weekday"} plus ${zloty(today.carried)} carried from yesterday`
      : `, ${zloty(today.base)} for the day less ${zloty(Math.abs(today.carried))} carried from yesterday`;

  return el(
    "p",
    { class: `today-line${tone}` },
    el("span", { class: "today-label", text: "Today" }),
    el("strong", { class: "today-figure", text: `${zloty(Math.max(0, today.left))} left of ${zloty(today.limit)}` }),
    el("span", { class: "today-note", text: today.left < 0
      ? `, ${zloty(Math.abs(today.left))} over${carried}`
      : carried })
  );
}

function weekLine() {
  const purse = weekendPurse();
  const { plan } = purse;
  if (!plan.spendable) return null;

  const saved = purse.counted === 0 ? null
    : purse.saved >= 0
      ? `${zloty(purse.carried)} of this week's ${zloty(purse.saved)} carried on`
      : `${zloty(Math.abs(purse.saved))} over so far`;

  return el(
    "p",
    { class: `week-line${purse.saved < 0 ? " is-over" : ""}` },
    el("strong", { text: `${zloty(plan.weekday)} a weekday · ${zloty(plan.weekend)} a weekend day` }),
    el("span", { text: saved ? `. ${saved}, ${zloty(purse.purse)} for the weekend` : `. ${zloty(purse.base)} for the weekend` })
  );
}

function renderDashboard() {
  // What matched the schedule is settled before anything is totalled, so the
  // figures and the queue can never disagree.
  classifyIncome();
  renderGreeting();
  renderToday();
  renderBalanceCard();
  renderDebrief();
  renderSaved();
  renderAsks();
  renderOutside();
  renderBudgetMap();
  renderCategoryBars();
  renderRateCard();
}

/** Everything that has to change when a transaction does. */
function moneyChanged() {
  renderMoney();
  renderRules();
  renderReport();
  renderDashboard();
  // The reading is part of the page, so it is redrawn with the rest of it --
  // and it says for itself whether the numbers have moved under it.
  renderReading(insightCache());
}

/* ---------- What your spending says ---------- */

/*
  The analysis is not a place you go. It reads the month when the page opens,
  it writes the line under the greeting, it moves the budgets on the map, and
  it fills the card below -- four short pieces, in the order somebody actually
  wants them: what is going well, what is not, what to cut, what to change.

  What goes to the model is a summary, not a statement: a few dozen totals,
  the top payees, the recurring charges and the shape of the last four weeks.
  Nothing is sent until the page is opened, and nothing is sent twice for the
  same numbers -- the last reading is kept and only replaced when the data has
  moved.
*/

const MONEY_INSIGHT_KEY = "remembre.insight.v1";

/** Grosze to złoty as a plain number, which is what the model should see. */
const zl = (grosze) => Math.round(grosze) / 100;

/**
 * Everything the analysis gets. Deliberately small and deliberately complete:
 * totals it could not work out for itself, the payees behind them, and the
 * shape of the last four weeks.
 */
function buildDigest() {
  const read = sustainability();
  const balance = balanceNow();
  const thisMonth = state.moneyMonth || latestMonth();
  const now = monthReport(thisMonth);
  const before = monthReport(shiftMonth(thisMonth, -1));
  const budgets = parseBudgets(budgetsText());

  /*
    This month in detail; the ones before it as two numbers each.

    The months that have gone are context, not the subject: a category-level
    breakdown of August makes the summary three times the size and the advice
    no better, because nothing can be done about August.
  */
  const categories = [...now.byCategory.keys()]
    .filter((name) => name !== "income" && name !== "transfers")
    .map((name) => ({
      name,
      spent: zl(Math.abs(now.byCategory.get(name) || 0)),
      lastMonth: zl(Math.abs(before.byCategory.get(name) || 0)),
      budget: budgets.has(name) ? zl(budgets.get(name)) : null,
      count: liveTransactions().filter((entry) =>
        SPENT_OUT(entry) && (entry.category || "other") === name && monthOf(entry.date) === thisMonth).length,
    }))
    .filter((row) => row.spent > 0)
    .sort((a, b) => b.spent - a.spent);

  const history = [...new Set(liveTransactions().map((entry) => monthOf(entry.date)))]
    .filter((key) => key < thisMonth)
    .sort()
    .slice(-5)
    .map((key) => {
      const month = monthReport(key);
      return { month: key, out: zl(Math.abs(month.spent)), in: zl(month.received) };
    });

  const standing = incomeStanding(thisMonth);
  const externalOut = liveTransactions()
    .filter((entry) => entry.amount < 0 && entry.branch === "external" && monthOf(entry.date) === thisMonth)
    .reduce((sum, entry) => sum + Math.abs(entry.amount), 0);

  const payees = new Map();
  liveTransactions()
    .filter((entry) => SPENT_OUT(entry) && monthOf(entry.date) === thisMonth)
    .forEach((entry) => {
      const name = (entry.counterparty || entry.title || entry.description || "-").slice(0, 40);
      const held = payees.get(name) || { name, total: 0, count: 0, category: entry.category || "other" };
      held.total += Math.abs(entry.amount);
      held.count += 1;
      payees.set(name, held);
    });

  return {
    currency: "PLN",
    today: todayISO(),
    month: thisMonth,
    from: read.from || "",
    to: read.to || "",
    days: read.counted || 0,
    balance: balance ? { amount: zl(balance.amount), source: balance.source, asAt: balance.at || "" } : null,
    income: {
      planPerMonth: zl(standing.planned),
      arrivedThisMonth: zl(standing.arrived),
      stillToCome: zl(standing.toCome),
      schedule: incomePlan().map((slot) => ({ day: slot.day, amount: zl(slot.amount) })),
    },
    external: {
      note: "Money from outside the schedule and the spending it paid for. Counted apart from the plan: mention it only if it is large or frequent, and never as overspending.",
      inThisMonth: zl(standing.external),
      outThisMonth: zl(externalOut),
    },
    week: {
      note: "The month's spending money, split so weekdays are cheaper and the weekend is worth looking forward to. Both rates come to the same monthly total. What is not spent Monday to Thursday is carried onto the weekend.",
      weekdayRate: zl(weekPlan(thisMonth).weekday),
      weekendRate: zl(weekPlan(thisMonth).weekend),
      keptBackThisWeek: zl(weekendPurse().saved),
      weekendPurse: zl(weekendPurse().purse),
    },
    spending: {
      thisMonth: zl(Math.abs(now.spent)),
      lastMonth: zl(Math.abs(before.spent)),
      perDay: zl(read.perDay || 0),
      perDayLastWeek: zl(read.perDayRecent || 0),
      projectedMonth: zl(read.projected || 0),
      ownVerdict: read.verdict,
    },
    categories,
    earlierMonths: history,
    topPayees: [...payees.values()].sort((a, b) => b.total - a.total).slice(0, 12)
      .map((payee) => ({ ...payee, total: zl(payee.total) })),
    recurring: recurringCharges().slice(0, 10)
      .map((charge) => ({ name: charge.name, monthly: zl(charge.typical), seenInMonths: charge.months })),
    weeks: (read.weeks || []).map((week) => ({ from: week.from, to: week.to, out: zl(week.spent) })),
    biggest: now.biggest.map((entry) => ({
      what: entry.counterparty || entry.title || "-",
      amount: zl(Math.abs(entry.amount)),
      date: entry.date,
      category: entry.category || "other",
    })),
  };
}

/**
 * Whether the numbers have moved enough to be worth paying to read again.
 * A new coffee is not news; a fifth of the month's spending appearing is.
 */
function movedSince(cached, digest) {
  if (!cached || !cached.digest) return true;
  const was = cached.digest;
  if (was.month !== digest.month) return true;
  return Math.abs((digest.spending.thisMonth || 0) - (was.spending.thisMonth || 0))
    > Math.max(5, (was.spending.thisMonth || 0) * 0.05);
}

function worthReanalysing(cached, digest) {
  if (movedSince(cached, digest)) return true;
  // And three days without a fresh look, so a quiet week still gets one.
  const age = Date.now() - Date.parse(cached.at || 0);
  return !(age < 3 * 24 * 60 * 60 * 1000);
}

const insightCache = () => readStore(MONEY_INSIGHT_KEY, null);

let insightRunning = false;

async function askClaude(action, digest) {
  const res = await fetch(`/api/advise?action=${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ digest }),
    cache: "no-store",
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || (body && body.ok === false)) {
    throw new Error((body && (body.message || body.problem)) || `The server answered ${res.status}.`);
  }
  return body;
}

function setReadingStatus(text, busy) {
  const status = $("reading-status");
  if (!status) return;
  status.textContent = text;
  status.classList.toggle("is-busy", Boolean(busy));
}

/**
 * Runs when the half is opened, not on a button: the button version only ever
 * gets pressed on the day you already know the answer.
 */
async function runInsight({ force = false } = {}) {
  if (!$("money-reading") || insightRunning) return;

  const digest = buildDigest();
  if (digest.days < 7 || digest.categories.length === 0) {
    renderReading(insightCache());
    setReadingStatus("Less than a week of spending here. Import a bit more and this fills itself in.", false);
    return;
  }

  const cached = insightCache();
  if (!force && cached && !worthReanalysing(cached, digest)) {
    renderReading(cached);
    return;
  }

  insightRunning = true;
  renderReading(cached);
  setReadingStatus(cached ? "Having another look…" : "Reading your spending…", true);

  try {
    const answer = await askClaude("analyse", digest);
    if (answer.thin) {
      setReadingStatus(answer.message, false);
      return;
    }
    const record = {
      at: new Date().toISOString(),
      digest,
      result: answer.result || null,
      prose: answer.prose || "",
      cost: answer.cost || null,
    };
    writeStore(MONEY_INSIGHT_KEY, record);
    renderReading(record);
    renderGreeting();
    announce("The reading is ready.");
    // Having just read the month, it is the right moment to put the budgets
    // where the money is actually going.
    rebalanceBudgets();
  } catch (err) {
    setReadingStatus(err.message, false);
  } finally {
    insightRunning = false;
  }
}

/*
  Four pieces, in the order they are wanted: what is going well, what is not,
  what to cut, what to change. Each one is a heading and a sentence or two --
  an essay here would be read once and never again.
*/
const READING_PARTS = [
  ["working", "Where you do well", "is-good"],
  ["slipping", "Where you do not", "is-bad"],
  ["cut", "What to cut", "is-cut"],
  ["change", "What to change", "is-change"],
];

function renderReading(record) {
  const wrap = $("money-reading");
  if (!wrap) return;

  const head = [
    el("div", { class: "card-head" },
      el("h2", { class: "card-title", text: "What your spending says" }),
      el("button", {
        type: "button", class: "link-btn", text: "Read it again",
        onclick: () => runInsight({ force: true }),
      })),
    el("p", { class: "sync-status", id: "reading-status", role: "status" }),
  ];

  if (!record) {
    show(wrap, [...head, el("p", { class: "empty", text: "Nothing read yet." })]);
    return;
  }

  const result = record.result;
  if (!result) {
    show(wrap, [...head, el("p", { class: "insight-prose", text: record.prose || "Nothing came back." })]);
    return;
  }

  const stale = movedSince(record, buildDigest());

  show(wrap, [
    ...head,
    el("p", { class: "insight-headline", text: String(result.headline || result.brief || "") }),
    el("div", { class: "reading-grid" }, READING_PARTS.map(([key, title, tone]) => {
      const said = String(result[key] || "").trim();
      if (!said) return null;
      return el("div", { class: `reading-part ${tone}` },
        el("h3", { class: "reading-title", text: title }),
        el("p", { class: "reading-text", text: said }));
    }).filter(Boolean)),
    Array.isArray(result.watch) && result.watch.length
      ? el("div", { class: "insight-watch" },
          el("h3", { class: "insight-sub", text: "Worth watching" }),
          el("ul", { class: "watch-list" }, result.watch.slice(0, 3)
            .map((item) => el("li", { text: String(item) }))))
      : null,
    el("p", { class: "chart-caption", text: stale
      ? `Read ${ageInWords(record.at)}; the numbers have moved since.`
      : `Read ${ageInWords(record.at)}, from ${record.digest.days} days of data.` }),
  ]);
}

/* ---------- Letting the analysis move the budgets ---------- */

/*
  A budget that is wrong every month is not a budget, it is a reproach. If the
  coffee is 200 a month and the limit says 80, the limit is the thing that is
  wrong -- the money is being spent either way, and a plan that pretends
  otherwise gets ignored and takes the rest of the plan down with it.

  So the analysis moves them: it keeps the total at the income plan, raises
  the ones that are always overspent, and takes it from the ones with room.
  Every move is shown with its reason and a sentence of what it costs, the
  previous set is kept, and Undo puts it back in one tap. Automatic, because
  the reader asked for automatic; reversible, because automatic without
  reversible is just something happening to you.
*/

const MONEY_MOVES_KEY = "remembre.budgetmoves.v1";
const MONEY_AUTO_KEY = "remembre.autobudget.v1";
const MONEY_UNDO_KEY = "remembre.budgetsbefore.v1";

/*
  The budgets move on their own, and there is no switch about it. A switch is
  a question in a hat: it asks you, every time you see it, whether you still
  mean what you already said. What there is instead is Undo, which is an
  answer to something that actually happened.
*/
const autoBudget = () => true;

/** What the analysis last proposed, and whether it has been taken up. */
const budgetMoves = () => readStore(MONEY_MOVES_KEY, null);

/**
 * Turns a plan's limits into moves against what is set today. Only what
 * actually changes is a move: a limit the analysis left alone is not news.
 */
function movesFrom(lines) {
  const held = parseBudgets(budgetsText());
  return lines
    .map((line) => ({
      category: line.category,
      from: held.get(line.category) || 0,
      to: Math.round(line.limit) * 100,
      why: line.why || "",
    }))
    .filter((move) => move.to !== move.from);
}

/*
  The cap. However good the reasoning, a set of limits that adds up to
  everything that comes in leaves nothing to save -- and the analysis, asked
  to make the budgets fit the spending, will drift there if nothing stops it.
  So four fifths of the income plan is the ceiling, and moves that would go
  past it are scaled back to it rather than refused: the shape of the advice
  is kept, its size is not.
*/
const SPEND_CEILING = 0.8;

function capMoves(moves) {
  const planned = plannedMonthly();
  if (!planned) return moves;

  const held = parseBudgets(budgetsText());
  moves.forEach((move) => held.set(move.category, move.to));
  const total = [...held.values()].reduce((sum, limit) => sum + limit, 0);
  const ceiling = Math.round(planned * SPEND_CEILING);
  if (total <= ceiling) return moves;

  const scale = ceiling / total;
  return moves.map((move) => ({
    ...move,
    to: Math.round((move.to * scale) / 100) * 100,
    capped: true,
  }));
}

function applyMoves(rawMoves, { quiet = false } = {}) {
  const moves = capMoves(rawMoves || []);
  if (moves.length === 0) return;

  const before = budgetsText();
  const held = parseBudgets(before);
  moves.forEach((move) => held.set(move.category, move.to));

  const text = [`# Adjusted by the analysis on ${todayISO()}. Edit freely.`,
    ...[...held.entries()].map(([name, grosze]) => `${name} = ${Math.round(grosze / 100)}`)].join("\n") + "\n";

  writeStore(MONEY_UNDO_KEY, before);
  writeStore(MONEY_BUDGETS_KEY, text);
  touchMoneySettings();
  const box = $("money-budgets");
  if (box) box.value = text;

  writeStore(MONEY_MOVES_KEY, { at: new Date().toISOString(), moves, applied: true });
  moneyChanged();

  if (quiet) return;
  const said = moves.slice(0, 3)
    .map((move) => `${move.category} ${move.from ? zloty(move.from) : "-"} → ${zloty(move.to)}`)
    .join(", ");
  const capped = moves.some((move) => move.capped)
    ? ` Held to ${Math.round(SPEND_CEILING * 100)}% of the plan, so a fifth is still saved.`
    : "";
  showMoneyNotice(`Budgets adjusted to how you actually spend: ${said}${moves.length > 3 ? ", and more" : ""}.${capped}`, {
    tone: "good",
    act: { label: "Undo", go: undoMoves },
  });
  announce("Budgets adjusted.");
}

function undoMoves() {
  const before = readStore(MONEY_UNDO_KEY, null);
  if (typeof before !== "string") return;
  writeStore(MONEY_BUDGETS_KEY, before);
  const box = $("money-budgets");
  if (box) box.value = before;
  writeStore(MONEY_UNDO_KEY, null);
  const held = budgetMoves();
  if (held) writeStore(MONEY_MOVES_KEY, { ...held, applied: false, undone: true });
  moneyChanged();
  showMoneyNotice("");
  announce("Budgets put back.");
}

/** The moves, under the map, so the picture and the reason sit together. */
function renderMoves() {
  const held = budgetMoves();
  if (!held || !Array.isArray(held.moves) || held.moves.length === 0) return null;

  return el(
    "div",
    {},
    el("p", { class: "chart-caption", text: held.applied
      ? `Adjusted ${ageInWords(held.at)} to how you actually spend.`
      : `Proposed ${ageInWords(held.at)}, not applied.` }),
    el("ul", { class: "moves" }, held.moves.slice(0, 6).map((move) => el(
      "li",
      { class: "move" },
      el("span", { class: "move-cat", text: move.category }),
      el("span", { class: "move-from", text: move.from ? zloty(move.from) : "none" }),
      el("span", { text: "→" }),
      el("span", { class: "move-to", text: zloty(move.to) }),
      el("span", { class: "move-why", text: move.why })
    ))),
    el(
      "div",
      { class: "panel-actions" },
      held.applied
        ? el("button", { type: "button", class: "btn btn-quiet btn-tiny", text: "Put them back", onclick: undoMoves })
        : el("button", {
            type: "button", class: "btn btn-primary btn-tiny", text: "Use these",
            onclick: () => applyMoves(held.moves),
          })
    )
  );
}

/**
 * Asks for a set of limits and, if the reader has left it on, puts them in.
 * Runs off the back of the analysis rather than off a button, which is the
 * point: budgets that need a button never get adjusted.
 */
async function rebalanceBudgets({ byHand = false } = {}) {
  const digest = buildDigest();
  if (digest.days < 7) {
    if (byHand) showMoneyNotice("There is not enough spending here yet to rebalance anything.", { tone: "plain" });
    return;
  }

  try {
    const answer = await askClaude("plan", digest);
    const lines = (answer.result && Array.isArray(answer.result.monthly) ? answer.result.monthly : [])
      .filter((row) => row && row.category && Number.isFinite(Number(row.limit)))
      .map((row) => ({ category: String(row.category).toLowerCase().slice(0, 40), limit: Number(row.limit), why: String(row.why || "") }));

    const moves = movesFrom(lines);
    if (moves.length === 0) {
      writeStore(MONEY_MOVES_KEY, null);
      moneyChanged();
      if (byHand) showMoneyNotice("Your budgets already match how you spend. Nothing worth moving.", { tone: "good" });
      return;
    }

    writeStore(MONEY_MOVES_KEY, { at: new Date().toISOString(), moves, applied: false });
    if (autoBudget()) applyMoves(moves);
    else {
      moneyChanged();
      showMoneyNotice(`The analysis would move ${moves.length} ${moves.length === 1 ? "budget" : "budgets"}. It is on the map.`, { tone: "plain" });
    }
  } catch (err) {
    if (byHand) showMoneyNotice(`The analysis could not be reached: ${err.message}`, { tone: "warn" });
  }
}

/* ---------- Wiring what is left ---------- */

/* The map is laid out from the measured width, so it is redrawn when that
   changes. Debounced: a drag of the window edge is one redraw, not forty. */
let mapTimer = 0;
function watchWidth() {
  window.addEventListener("resize", () => {
    window.clearTimeout(mapTimer);
    mapTimer = window.setTimeout(() => {
      if (state.area === "money") renderBudgetMap();
    }, 120);
  });
}

function setupInsight() {
  if (!$("money-reading")) return;
  setupOutside();
  fetchDebrief();
  if ($("map-rebalance")) {
    $("map-rebalance").addEventListener("click", () => {
      showMoneyNotice("Working out where the money actually goes…", { tone: "plain", keep: false });
      rebalanceBudgets({ byHand: true });
    });
  }
  watchWidth();
}
