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
    el("span", { class: "tx-amount", text: zloty(entry.amount) })
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
  saveTransactions();
  renderMoney();

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

  renderMoney();
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
    writeStore(MONEY_KEY, state.transactions);
    renderMoney();
  }
  return changed;
}
