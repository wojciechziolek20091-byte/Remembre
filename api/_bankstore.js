/*
  What the server remembers about a reader's bank connection, and the rule that
  stops the same purchase being stored twice.

  The connection is filed against the vault key -- the same one-way hash of the
  sync phrase the rest of the app uses -- so the nightly job can refresh an
  account without anybody's phrase being stored anywhere.
*/

import { randomUUID } from "node:crypto";

export const connectionKey = (vault) => `bank_${vault}`;
export const handoverKey = (nonce) => `bankauth_${nonce}`;
export const BANK_INDEX = "bank_index";

export const newNonce = () => randomUUID().replace(/-/g, "");

export async function readJson(store, key, fallback) {
  const raw = await store.get(key);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch (err) {
    return fallback;
  }
}

export async function saveConnection(store, vault, record) {
  await store.put(connectionKey(vault), JSON.stringify(record));
  const index = await readJson(store, BANK_INDEX, []);
  const vaults = Array.isArray(index) ? index : [];
  if (!vaults.includes(vault)) await store.put(BANK_INDEX, JSON.stringify([...vaults, vault]));
}

export const loadConnection = (store, vault) => readJson(store, connectionKey(vault), null);

export async function listConnections(store) {
  const index = await readJson(store, BANK_INDEX, []);
  const vaults = Array.isArray(index) ? index : [];
  const found = await Promise.all(vaults.map((vault) => loadConnection(store, vault)));
  return found.map((record, i) => (record ? { vault: vaults[i], ...record } : null)).filter(Boolean);
}

/* ---------- Not storing the same purchase twice ---------- */

/*
  A transaction that arrived in a CSV and the same transaction fetched from the
  bank do not look alike. The bank's API and its own CSV export word the payee
  and the description differently, so matching on their text would see two
  purchases where there was one.

  What they do agree on is the day and the amount. So the rule is: for a given
  day and amount, the Nth one is the Nth one. Rows that share both are
  interchangeable by definition -- if two coffees cost the same at the same
  shop on the same day, which is "first" is a question with no answer -- which
  is exactly what makes counting them safe where matching their text is not.

  The cost is honest and worth writing down: two genuinely different purchases
  of the same amount on the same day are counted correctly but may end up
  wearing each other's payee. Totals and budgets are unaffected; a category
  might be.
*/
const slotOf = (row) => `${row.date}|${row.amount}`;

export function onlyNewRows(existing, incoming) {
  const seen = new Map();
  (Array.isArray(existing) ? existing : []).forEach((row) => {
    if (!row || row.deleted) return;
    const slot = slotOf(row);
    seen.set(slot, (seen.get(slot) || 0) + 1);
  });

  const fresh = [];
  const taken = new Map();
  incoming.forEach((row) => {
    const slot = slotOf(row);
    const index = (taken.get(slot) || 0) + 1;
    taken.set(slot, index);
    // The first `seen` of each slot are already stored, whatever they say.
    if (index <= (seen.get(slot) || 0)) return;
    fresh.push(row);
  });

  return fresh;
}

/* ---------- A note of what happened, for when nothing happens ---------- */

/*
  Connecting is a round trip through the bank, and when it fails it fails on
  the way back: the reader lands on a page that looks exactly as it did
  before. Without this there is no way to tell "the bank refused" from "the
  bank returned no accounts" from "nobody ever tapped the button" -- not from
  the page, and not from here either.

  What goes in is an outcome and a short reason. Never the code, never the
  nonce, never the vault key, never anything about an account: the whole point
  is that it can be read by anybody without telling them whose it is.
*/
export const BANK_JOURNAL = "bank_journal";
const JOURNAL_KEEP = 20;

export async function noteOutcome(store, outcome, detail = "") {
  try {
    const held = await readJson(store, BANK_JOURNAL, []);
    const entries = Array.isArray(held) ? held : [];
    entries.push({
      at: new Date().toISOString(),
      outcome: String(outcome).slice(0, 40),
      detail: String(detail).slice(0, 200),
    });
    await store.put(BANK_JOURNAL, JSON.stringify(entries.slice(-JOURNAL_KEEP)));
  } catch (err) {
    // A journal that cannot be written must never break the thing it watches.
    console.error("bank journal write failed:", err.message);
  }
}

export async function readJournal(store) {
  const held = await readJson(store, BANK_JOURNAL, []);
  return Array.isArray(held) ? held : [];
}
