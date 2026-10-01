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
  recategorise();
  saveTransactions();
  // A fresh import usually brings the newest month with it, and opening on an
  // empty month would look like the import had failed.
  state.moneyMonth = latestMonth();
  renderMoney();
  renderRules();
  renderReport();

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
  // Rules may have been edited on a visit when nothing was imported yet, and
  // transactions may have arrived from the other device since.
  recategorise();
  renderMoney();
  renderRules();
  renderReport();
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
    renderMoney();
    renderRules();
    renderReport();
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
    renderMoney();
    renderRules();
    renderReport();
    announce(changed === 0
      ? "Rules saved. Nothing changed category."
      : `Rules saved. ${changed} ${changed === 1 ? "transaction" : "transactions"} recategorised.`);
  });

  $("money-rules-reset").addEventListener("click", () => {
    if (!window.confirm("Put the default rules back? Anything you have written here will be lost.")) return;
    writeStore(MONEY_RULES_KEY, DEFAULT_RULES);
    recategorise();
    renderMoney();
    renderRules();
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
  });
  $("money-next").addEventListener("click", () => {
    state.moneyMonth = shiftMonth(state.moneyMonth || latestMonth(), 1);
    renderReport();
  });
  $("money-budgets").value = budgetsText();
  $("money-budgets-save").addEventListener("click", () => {
    writeStore(MONEY_BUDGETS_KEY, $("money-budgets").value);
    renderReport();
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
      // The server wrote them into the vault, so the way to see them is the
      // same sync that carries everything else.
      await runCloud(() => cloudPull({ quiet: true }));
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
