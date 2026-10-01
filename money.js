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
      `${entries.length} transactions · ${zloty(spent)} out · ${zloty(paidIn)} in · ` +
      `${entries[entries.length - 1].date} to ${entries[0].date}`;
  }

  list.replaceChildren(el("ul", { class: "tx-list" }, entries.slice(0, 200).map((entry) => el(
    "li",
    { class: `tx${entry.amount < 0 ? "" : " is-in"}` },
    el("span", { class: "tx-date", text: entry.date.slice(5) }),
    el(
      "span",
      { class: "tx-what" },
      el("span", { class: "tx-title", text: entry.counterparty || entry.title || entry.description || "—" }),
      entry.title && entry.counterparty
        ? el("span", { class: "tx-note", text: entry.title })
        : null
    ),
    el("span", { class: "tx-amount", text: zloty(entry.amount) }),
    el("span", {
      class: `tx-cat${(entry.category || "other") === "other" ? " is-loose" : ""}`,
      text: entry.category || "other",
    })
  ))));
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
    if (entry.deleted) return;
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
    const changed = recategorise();
    moneyChanged();
    announce(changed === 0
      ? "Rules saved. Nothing changed category."
      : `Rules saved. ${changed} ${changed === 1 ? "transaction" : "transactions"} recategorised.`);
  });

  $("money-rules-reset").addEventListener("click", () => {
    if (!window.confirm("Put the default rules back? Anything you have written here will be lost.")) return;
    writeStore(MONEY_RULES_KEY, DEFAULT_RULES);
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
  const entries = liveTransactions().filter((entry) => monthOf(entry.date) === key);
  const out = entries.filter((entry) => entry.amount < 0);

  const byCategory = new Map();
  out.forEach((entry) => {
    const name = entry.category || "other";
    byCategory.set(name, (byCategory.get(name) || 0) + entry.amount);
  });

  return {
    key,
    count: entries.length,
    spent: out.reduce((sum, entry) => sum + entry.amount, 0),
    received: entries.filter((e) => e.amount > 0).reduce((sum, e) => sum + e.amount, 0),
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
    pieces.push(el("ul", { class: "report-list" }, now.biggest.map((entry) => el(
      "li",
      { class: "report-row" },
      el("span", { class: "report-name", text: entry.counterparty || entry.title || "—" }),
      el("span", { class: "report-now", text: zloty(entry.amount) }),
      el("span", { class: "report-was", text: `${entry.date.slice(5)} · ${entry.category || "other"}` })
    ))));
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
  $("money-budgets").value = budgetsText();
  $("money-budgets-save").addEventListener("click", () => {
    writeStore(MONEY_BUDGETS_KEY, $("money-budgets").value);
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

  // The balance travels with the status, so this is where it is picked up.
  bankBalance = (connection && connection.balance) || bankBalance;

  const connect = $("bank-connect");
  const fetchNow = $("bank-fetch");

  if (!bankPhrase()) {
    status.textContent = "Turn on automatic syncing first — the server needs to know whose account this is.";
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
    status.textContent = `${accounts} — mBank wants you to approve again.`;
    status.classList.add("is-stale");
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
  What the callback told us, carried back in the address. Read once and then
  cleaned out of the URL, so a reload does not announce a week-old outcome.
*/
const BANK_OUTCOMES = {
  connected: "mBank is connected. Fetching your transactions now.",
  refused: "mBank was not approved, so nothing is connected.",
  expired: "That took too long. Try connecting again.",
  "no-accounts": "mBank approved it but returned no accounts. Link the account in the Enable Banking Control Panel first.",
  "bad-return": "mBank sent back something unexpected. Try connecting again.",
  "no-store": "The server has no storage attached, so there is nowhere to keep the connection.",
  failed: "Connecting failed. Try again.",
};

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
      $("bank-connect").disabled = false;
      renderBank(null);
    }
  });

  $("bank-fetch").addEventListener("click", async () => {
    $("bank-fetch").disabled = true;
    try {
      const result = await bankCall("fetch");
      bankNote = "";
      if (result.balance) bankBalance = result.balance;
      // The server wrote them into the vault, so the way to see them is the
      // same sync that carries everything else.
      await runCloud(() => cloudPull({ quiet: true }));
      moneyChanged();
      announce(result.added === 0
        ? "Nothing new at the bank."
        : `${result.added} new ${result.added === 1 ? "transaction" : "transactions"} from mBank.`);
      await refreshBank();
    } catch (err) {
      bankNote = err.message;
      renderBank(null);
    } finally {
      $("bank-fetch").disabled = false;
    }
  });

  const outcome = readBankOutcome();
  if (outcome) {
    announce(BANK_OUTCOMES[outcome] || "Something happened connecting to mBank.");
    // Coming back from the bank always lands on the half it concerns.
    setArea("money");
    if (outcome === "connected") {
      refreshBank().then(() => $("bank-fetch").click());
      return;
    }
    bankNote = BANK_OUTCOMES[outcome] || "";
  }

  // Otherwise the panel is drawn from what is known, and the server is asked
  // only when this half is opened -- see setArea.
  renderBank(null);
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

/* ---------- How fast it is going ---------- */

/*
  Spending is money out that left for good. A transfer to your own account has
  not been spent -- it has moved -- and counting it makes a week look twice as
  expensive as it was. Cash withdrawals stay in: the money has left the
  account and where it went afterwards is not something a statement knows.
*/
const SPENT_OUT = (entry) => entry.amount < 0 && (entry.category || "other") !== "transfers";

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

  const { typical, months } = typicalIncome();
  const balance = balanceNow();
  const cover = perDay > 0 && balance ? Math.floor(balance.amount / perDay) : null;

  let verdict = "unclear";
  let why = "";
  const share = typical > 0 ? projected / typical : 0;

  if (counted < 14) {
    why = `Only ${counted} ${counted === 1 ? "day" : "days"} of data, so this is a guess rather than a rate.`;
  } else if (typical <= 0) {
    why = "Nothing has come in yet, so there is nothing to measure the spending against.";
  } else if (share <= 0.85) {
    verdict = "sustainable";
    why = `At ${zloty(perDay)} a day this month would cost ${zloty(projected)}, against ${zloty(typical)} coming in.`;
  } else if (share <= 1) {
    verdict = "tight";
    why = `At ${zloty(perDay)} a day this month would cost ${zloty(projected)} — almost exactly the ${zloty(typical)} coming in.`;
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

function renderBalanceCard() {
  const card = $("money-balance");
  if (!card) return;

  const balance = balanceNow();
  if (!balance) {
    show(card, [
      el("p", { class: "kpi-label", text: "Current balance" }),
      el("p", { class: "kpi-figure is-missing", text: "—" }),
      el("p", {
        class: "kpi-note",
        text: "No statement has told us what is in the account yet. Import a CSV, or connect mBank and it arrives on its own.",
      }),
    ]);
    return;
  }

  const movement = balanceMovement(balance);
  const monthKey = state.moneyMonth || latestMonth();
  const month = monthReport(monthKey);
  const when = monthName(monthKey).split(" ")[0];

  const provenance = balance.source === "bank"
    ? `Straight from mBank${balance.readAt ? `, read ${ageInWords(balance.readAt)}` : ""}.`
    : `From the statement that closed on ${balance.at}${
        balance.since ? `, plus ${balance.since} ${balance.since === 1 ? "transaction" : "transactions"} since (${zloty(balance.pending)})` : ""
      }.`;

  show(card, [
    el("p", { class: "kpi-label", text: "Current balance" }),
    el("p", { class: `kpi-figure${balance.amount < 0 ? " is-negative" : ""}`, text: zloty(balance.amount) }),
    movement
      ? el("p", {
          class: `kpi-move${movement.change < 0 ? " is-down" : " is-up"}`,
          text: `${movement.change < 0 ? "↓" : "↑"} ${zloty(Math.abs(movement.change))} since you last looked`,
        })
      : null,
    el("p", { class: "kpi-note", text: provenance }),
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

/** The top handful of payees inside one category, for when a bar is opened. */
function payeesIn(category, monthKey) {
  const totals = new Map();
  liveTransactions()
    .filter((entry) => SPENT_OUT(entry) && (entry.category || "other") === category && monthOf(entry.date) === monthKey)
    .forEach((entry) => {
      const name = (entry.counterparty || entry.title || entry.description || "—").slice(0, 40);
      const held = totals.get(name) || { name, total: 0, count: 0 };
      held.total += Math.abs(entry.amount);
      held.count += 1;
      totals.set(name, held);
    });
  return [...totals.values()].sort((a, b) => b.total - a.total).slice(0, 4);
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
      ].filter(Boolean).join(" · ");

      const detail = el("ul", { class: "bar-detail", hidden: true });

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
            if (!open && detail.childElementCount === 0) {
              detail.replaceChildren(...payeesIn(row.name, monthKey).map((payee) => el(
                "li",
                { class: "payee" },
                el("span", { class: "payee-name", text: payee.name }),
                el("span", { class: "payee-count", text: `${payee.count}×` }),
                el("span", { class: "payee-sum", text: zloty(-payee.total) })
              )));
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
      el("span", { class: "week-when", text: `${week.from.slice(5)} – ${week.to.slice(5)}` }),
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
          el("th", { scope: "row", text: `${week.from} – ${week.to}` }),
          el("td", { text: zloty(-week.spent) }),
          el("td", { text: zloty(Math.round(week.spent / week.length)) })))))
    ),
  ]);
}

function renderDashboard() {
  renderBalanceCard();
  renderCategoryBars();
  renderRateCard();
}

/** Everything that has to change when a transaction does. */
function moneyChanged() {
  renderMoney();
  renderRules();
  renderReport();
  renderDashboard();
  noteInsightStale();
}

/* ---------- The analytics sector ---------- */

/*
  This half of the money app is the one that reads the numbers back to you, and
  it does it without being asked: open the page and it has already run, or it
  runs now. Being asked is the problem with every other tool like this -- you
  only press the button on the day you already know the answer.

  What goes to the model is a summary, not a statement. The arithmetic has been
  done here; what travels is a few dozen totals, the top payees and the
  recurring charges. That is cheaper, faster, and the only part a model can
  actually use. Nothing is sent until the page is opened, and nothing is sent
  twice for the same numbers -- the last reading is kept and only replaced when
  the data has moved.
*/

const MONEY_INSIGHT_KEY = "remembre.insight.v1";
const MONEY_PLAN_KEY = "remembre.plan.v1";

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
  const { typical, months } = typicalIncome();

  const categories = [...new Set([...now.byCategory.keys(), ...before.byCategory.keys()])]
    .filter((name) => name !== "income")
    .map((name) => ({
      name,
      thisMonth: zl(Math.abs(now.byCategory.get(name) || 0)),
      lastMonth: zl(Math.abs(before.byCategory.get(name) || 0)),
      budget: budgets.has(name) ? zl(budgets.get(name)) : null,
      count: liveTransactions().filter((entry) =>
        (entry.category || "other") === name && monthOf(entry.date) === thisMonth).length,
    }))
    .filter((row) => row.thisMonth > 0 || row.lastMonth > 0)
    .sort((a, b) => b.thisMonth - a.thisMonth);

  const payees = new Map();
  liveTransactions()
    .filter((entry) => SPENT_OUT(entry) && monthOf(entry.date) === thisMonth)
    .forEach((entry) => {
      const name = (entry.counterparty || entry.title || entry.description || "—").slice(0, 40);
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
    income: { typicalMonth: zl(typical), monthsSeen: months, thisMonth: zl(now.received) },
    spending: {
      thisMonth: zl(Math.abs(now.spent)),
      lastMonth: zl(Math.abs(before.spent)),
      perDay: zl(read.perDay || 0),
      perDayLastWeek: zl(read.perDayRecent || 0),
      projectedMonth: zl(read.projected || 0),
      ownVerdict: read.verdict,
    },
    categories,
    topPayees: [...payees.values()].sort((a, b) => b.total - a.total).slice(0, 12)
      .map((payee) => ({ ...payee, total: zl(payee.total) })),
    recurring: recurringCharges().slice(0, 10)
      .map((charge) => ({ name: charge.name, monthly: zl(charge.typical), seenInMonths: charge.months })),
    weeks: (read.weeks || []).map((week) => ({ from: week.from, to: week.to, out: zl(week.spent) })),
    biggest: now.biggest.map((entry) => ({
      what: entry.counterparty || entry.title || "—",
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

function insightCache() { return readStore(MONEY_INSIGHT_KEY, null); }
function planCache() { return readStore(MONEY_PLAN_KEY, null); }

/** Marks a stored reading as describing older numbers than the ones now held. */
function noteInsightStale() {
  const note = $("insight-stale");
  if (!note) return;
  // Only the numbers moving is worth saying out loud here. A reading that is
  // merely three days old is still describing the right month.
  const cached = insightCache();
  note.hidden = !(cached && movedSince(cached, buildDigest()));
}

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

/*
  The two cards keep their own status line. One line shared between them meant
  the plan's "working..." wiped out when the reading was written, which is the
  one thing on the page that says whether it is current.
*/
function setStatus(id, text, busy) {
  const status = $(id);
  if (!status) return;
  status.textContent = text;
  status.classList.toggle("is-busy", Boolean(busy));
}

const setInsightStatus = (text, busy) => setStatus("insight-status", text, busy);
const setPlanStatus = (text, busy) => setStatus("plan-status", text, busy);

/**
 * Runs the analysis. Called on opening the page, not on a button: the button
 * version only ever gets pressed on the day you already know the answer.
 */
async function runInsight({ force = false } = {}) {
  if (!$("insight-reading") || insightRunning) return;

  const digest = buildDigest();
  if (digest.days < 7 || digest.categories.length === 0) {
    renderInsight(null);
    setInsightStatus("There is less than a week of spending here. Import a bit more and this page will have something to say.", false);
    return;
  }

  const cached = insightCache();
  if (!force && cached && !worthReanalysing(cached, digest)) {
    renderInsight(cached);
    return;
  }

  insightRunning = true;
  if (cached) renderInsight(cached);
  setInsightStatus("Reading your spending…", true);

  try {
    const answer = await askClaude("analyse", digest);
    if (answer.thin) {
      setInsightStatus(answer.message, false);
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
    renderInsight(record);
    announce("The analysis is ready.");
  } catch (err) {
    setInsightStatus(err.message, false);
  } finally {
    insightRunning = false;
    noteInsightStale();
  }
}

function renderInsight(record) {
  const wrap = $("insight-reading");
  if (!wrap) return;

  if (!record) {
    wrap.replaceChildren();
    return;
  }

  setInsightStatus(`Read ${ageInWords(record.at)}, from ${record.digest.days} days of data.`, false);
  noteInsightStale();

  const result = record.result;
  if (!result) {
    wrap.replaceChildren(el("p", { class: "insight-prose", text: record.prose || "Nothing came back." }));
    return;
  }

  const verdict = VERDICTS[result.verdict] || VERDICTS.unclear;

  show(wrap, [
    el("p", { class: "insight-headline", text: String(result.headline || "") }),
    el(
      "div",
      { class: `verdict is-${VERDICTS[result.verdict] ? result.verdict : "unclear"}` },
      el("span", { class: "verdict-mark", "aria-hidden": "true", text: verdict.mark }),
      el("span", { class: "verdict-words" }, el("strong", { class: "verdict-label", text: verdict.label }))
    ),
    ...String(result.reading || "").split(/\n{2,}/).filter(Boolean)
      .map((para) => el("p", { class: "insight-prose", text: para.trim() })),
    Array.isArray(result.notes) && result.notes.length
      ? el("ul", { class: "insight-notes" }, result.notes.slice(0, 6).map((note) => el(
          "li",
          {},
          el("strong", { text: String(note.label || "") }),
          el("span", { text: ` ${String(note.detail || "")}` })
        )))
      : null,
    Array.isArray(result.watch) && result.watch.length
      ? el("div", { class: "insight-watch" },
          el("h3", { class: "insight-sub", text: "Worth watching" }),
          el("ul", { class: "watch-list" }, result.watch.slice(0, 3)
            .map((item) => el("li", { text: String(item) }))))
      : null,
  ]);
}

/* ---------- The plan ---------- */

/*
  The plan is on a button, and that is the one thing on this page that should
  be: an analysis of what already happened costs nothing to be wrong about, but
  a budget is a decision, and a decision nobody asked for is noise.
*/
async function runPlan() {
  const button = $("insight-plan");
  if (!button) return;

  const digest = buildDigest();
  if (digest.days < 7) {
    setPlanStatus("Not enough data to build a plan from yet.", false);
    return;
  }

  button.disabled = true;
  setPlanStatus("Working out a plan…", true);
  try {
    const answer = await askClaude("plan", digest);
    const record = { at: new Date().toISOString(), digest, result: answer.result || null, prose: answer.prose || "" };
    writeStore(MONEY_PLAN_KEY, record);
    renderPlan(record);
    setPlanStatus(`Plan written ${ageInWords(record.at)}.`, false);
    announce("A plan is ready.");
  } catch (err) {
    setPlanStatus(err.message, false);
  } finally {
    button.disabled = false;
  }
}

function renderPlan(record) {
  const wrap = $("insight-plan-out");
  if (!wrap) return;
  if (!record) {
    wrap.replaceChildren();
    return;
  }

  setPlanStatus(`Plan written ${ageInWords(record.at)}.`, false);

  const result = record.result;
  if (!result || !Array.isArray(result.monthly)) {
    wrap.replaceChildren(el("p", { class: "insight-prose", text: record.prose || "Nothing came back." }));
    return;
  }

  const lines = result.monthly
    .filter((row) => row && row.category && Number.isFinite(Number(row.limit)))
    .map((row) => ({
      category: String(row.category).toLowerCase().slice(0, 40),
      limit: Math.round(Number(row.limit)),
      was: Number.isFinite(Number(row.was)) ? Math.round(Number(row.was)) : null,
      why: String(row.why || ""),
    }));

  show(wrap, [
    el("p", { class: "insight-prose", text: String(result.approach || "") }),
    result.save && Number.isFinite(Number(result.save.amount))
      ? el("p", { class: "plan-save" },
          el("strong", { text: `Put aside ${zloty(Math.round(Number(result.save.amount)) * 100)} a month. ` }),
          el("span", { text: String(result.save.why || "") }))
      : null,
    el(
      "table",
      { class: "plain-table plan-table" },
      el("thead", {}, el("tr", {},
        el("th", { scope: "col", text: "Category" }),
        el("th", { scope: "col", text: "Now" }),
        el("th", { scope: "col", text: "Limit" }),
        el("th", { scope: "col", text: "Why" }))),
      el("tbody", {}, lines.map((line) => el(
        "tr",
        {},
        el("th", { scope: "row", class: "plan-cat", text: line.category }),
        el("td", { text: line.was === null ? "—" : zloty(line.was * 100) }),
        el("td", { class: "plan-limit", text: zloty(line.limit * 100) }),
        el("td", { class: "plan-why", text: line.why })
      )))
    ),
    Array.isArray(result.tradeoffs) && result.tradeoffs.length
      ? el("div", { class: "insight-watch" },
          el("h3", { class: "insight-sub", text: "What it costs" }),
          el("ul", { class: "watch-list" }, result.tradeoffs.slice(0, 3)
            .map((item) => el("li", { text: String(item) }))))
      : null,
    result.year ? el("p", { class: "plan-year", text: String(result.year) }) : null,
    lines.length
      ? el("div", { class: "panel-actions" }, el("button", {
          type: "button",
          class: "btn btn-primary",
          text: "Use these as my budgets",
          onclick: () => applyPlanBudgets(lines),
        }))
      : null,
  ]);
}

/**
 * Writes the plan into the budgets box, which is the thing the rest of the app
 * already watches. Nothing is applied silently: this is a button, the old text
 * is shown underneath it in the Categories panel, and the numbers are the ones
 * on screen.
 */
function applyPlanBudgets(lines) {
  const header = "# Written from the plan on " + todayISO() + ". Edit freely.";
  const text = [header, ...lines.map((line) => `${line.category} = ${line.limit}`)].join("\n") + "\n";
  writeStore(MONEY_BUDGETS_KEY, text);
  const box = $("money-budgets");
  if (box) box.value = text;
  renderReport();
  renderDashboard();
  announce("Budgets updated from the plan.");
  setPlanStatus("Budgets updated. They are in the Categories panel if you want to change them.", false);
}

/* ---------- Which page of the money half ---------- */

function setMoneyPage(page) {
  const insight = page === "insight";
  if ($("money-dash")) $("money-dash").hidden = insight;
  if ($("money-insight")) $("money-insight").hidden = !insight;
  document.querySelectorAll("[data-money-page]").forEach((button) => {
    const mine = button.dataset.moneyPage === (insight ? "insight" : "dash");
    button.setAttribute("aria-selected", mine ? "true" : "false");
    button.classList.toggle("is-on", mine);
  });
  if (insight) {
    renderInsight(insightCache());
    renderPlan(planCache());
    runInsight();
  }
}

function setupInsight() {
  if (!$("money-insight")) return;

  document.querySelectorAll("[data-money-page]").forEach((button) => {
    button.addEventListener("click", () => setMoneyPage(button.dataset.moneyPage));
  });

  $("insight-again").addEventListener("click", () => runInsight({ force: true }));
  $("insight-plan").addEventListener("click", () => runPlan());
  setMoneyPage("dash");
}
