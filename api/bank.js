import { checkCode, cors, json, notConfigured, store, vaultKey } from "./_store.js";
import { asTransaction, bankAuthorise, bankFetch, bankReport, bankTransactions, CONSENT_DAYS } from "./_bank.js";
import {
  handoverKey, listConnections, loadConnection, newNonce, onlyNewRows, saveConnection,
} from "./_bankstore.js";

/**
 * Read-only bank access.
 *
 *   GET /api/bank?action=check   can this deployment talk to Enable Banking?
 *
 * "check" asks for the list of Polish banks, which is the smallest call that
 * proves the application id and the signature are both right. It returns a
 * count rather than the list: this is a yes-or-no, not a data route.
 */
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "GET" && req.method !== "POST") {
    return json(res, 405, { error: "method-not-allowed" });
  }

  const report = bankReport();
  if (!report.configured) {
    return json(res, 503, { ok: false, configured: false, problem: report.problem });
  }

  const url = new URL(req.url, "http://localhost");
  const action = url.searchParams.get("action") || "check";

  if (action === "connect") return startConnecting(req, res);
  if (action === "status") return connectionStatus(req, res);
  if (action === "fetch") return fetchForOne(req, res);
  if (action === "daily") return fetchForEveryone(req, res);
  if (action !== "check") {
    return json(res, 400, { error: "unknown-action", message: `There is no "${action}".` });
  }

  try {
    const answer = await bankFetch("/aspsps?country=PL");
    const banks = Array.isArray(answer && answer.aspsps) ? answer.aspsps : [];

    /*
      On the free plan the API only ever returns accounts that were linked by
      hand in the Control Panel, so "the credentials work" and "there is
      anything to read" are different questions. This asks the second one too,
      because the difference between them is a step the reader has to take and
      would otherwise only discover when a fetch came back empty.
    */
    let application = null;
    try {
      application = await bankFetch("/application");
    } catch (err) {
      application = { unavailable: err.message };
    }

    return json(res, 200, {
      ok: true,
      configured: true,
      reached: true,
      polishBanks: banks.length,
      // Enough to see mBank is there without returning the whole catalogue.
      mbank: banks.some((bank) => /mbank/i.test(bank.name || "")),
      application: describeApplication(application),
    });
  } catch (err) {
    console.error("bank check failed:", err.status || "", err.message);
    return json(res, 502, {
      ok: false,
      configured: true,
      reached: false,
      status: err.status || 0,
      message: err.message,
    });
  }
}

/**
 * What the Control Panel says about this application, reduced to the parts
 * that answer "is there anything left to do". No ids, no URLs, no secrets.
 */
function describeApplication(application) {
  if (!application || application.unavailable) {
    return { readable: false, why: (application && application.unavailable) || "no answer" };
  }

  // The shape of this response is theirs to change, so look for the facts
  // rather than insisting on a particular field.
  const accounts = Array.isArray(application.accounts) ? application.accounts
    : Array.isArray(application.linked_accounts) ? application.linked_accounts
    : null;

  return {
    readable: true,
    name: String(application.name || ""),
    active: application.active !== false,
    environment: String(application.environment || ""),
    // "Restricted" is the free plan, and is expected rather than a problem.
    restricted: /restricted/i.test(JSON.stringify(application)),
    linkedAccounts: accounts ? accounts.length : null,
    keys: Object.keys(application).sort(),
  };
}

/* ---------- Connecting ---------- */

/** Where the bank sends the reader back to, derived rather than configured. */
function redirectUrl(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `https://${host}/api/bank-callback`;
}

/**
 * Starts an authorisation and hands back somewhere to send the reader.
 *
 * The sync phrase comes in, is turned straight into the vault key, and is not
 * kept: what is stored against the one-time nonce is the key, so the bank
 * never carries anything that identifies the reader and neither do the logs.
 */
async function startConnecting(req, res) {
  const live = store();
  if (!live) return notConfigured(res);

  const body = await readBody(req);
  const problem = checkCode(body && body.code);
  if (problem) return json(res, 400, { error: "bad-code", message: problem });

  try {
    const nonce = newNonce();
    const { url, validUntil } = await bankAuthorise({ redirectUrl: redirectUrl(req), state: nonce });
    await live.put(handoverKey(nonce), JSON.stringify({
      vault: vaultKey(body.code.trim()),
      validUntil,
      startedAt: new Date().toISOString(),
    }));
    return json(res, 200, { ok: true, url, validUntil, days: CONSENT_DAYS });
  } catch (err) {
    console.error("bank connect failed:", err.status || "", err.message);
    return json(res, 502, { ok: false, message: err.message });
  }
}

/** What this vault's connection looks like, without any account numbers. */
async function connectionStatus(req, res) {
  const live = store();
  if (!live) return notConfigured(res);

  const body = await readBody(req);
  const problem = checkCode(body && body.code);
  if (problem) return json(res, 400, { error: "bad-code", message: problem });

  const held = await loadConnection(live, vaultKey(body.code.trim()));
  if (!held) return json(res, 200, { ok: true, connected: false });

  return json(res, 200, {
    ok: true,
    connected: true,
    accounts: held.accounts.map((account) => ({ name: account.name, iban: account.iban })),
    validUntil: held.validUntil || "",
    connectedAt: held.connectedAt || "",
    fetchedTo: held.fetchedTo || "",
    expired: Boolean(held.validUntil) && held.validUntil < new Date().toISOString(),
  });
}

/* ---------- Fetching ---------- */

const HISTORY_DAYS = 90;        // What a first fetch reaches back for.
const OVERLAP_DAYS = 5;         // Re-read a few days: a late booking is common.

/**
 * Pulls new transactions into the vault for one connection.
 *
 * Deliberately refetches the last few days every time. Banks book card
 * payments a day or two after they happen, so a fetch that started exactly
 * where the last one stopped would miss them permanently -- and the rule in
 * onlyNewRows means re-reading them costs nothing.
 */
async function pullInto(live, vault, connection) {
  const from = connection.fetchedTo
    ? shiftDate(connection.fetchedTo, -OVERLAP_DAYS)
    : shiftDate(today(), -HISTORY_DAYS);

  const incoming = [];
  for (const account of connection.accounts) {
    const rows = await bankTransactions(account.uid, from);
    rows.map(asTransaction).filter(Boolean).forEach((row) => incoming.push(row));
  }

  incoming.sort((a, b) => (a.date === b.date ? a.amount - b.amount : a.date.localeCompare(b.date)));

  const vaultRaw = await live.get(vault);
  const held = vaultRaw ? safeParse(vaultRaw) : null;
  const stored = held && Array.isArray(held.transactions) ? held.transactions : [];

  const fresh = onlyNewRows(stored, incoming);
  const now = new Date().toISOString();
  const added = fresh.map((row, index) => ({
    ...row,
    id: `eb-${row.date.replace(/-/g, "")}-${Math.abs(row.amount)}-${index}-${Math.random().toString(36).slice(2, 8)}`,
    category: "",
    source: "api",
    deleted: false,
    createdAt: now,
    updatedAt: now,
  }));

  if (added.length > 0) {
    const next = held && typeof held === "object" ? held : { tasks: [], coursework: [], sessions: [] };
    next.transactions = [...stored, ...added];
    next.updatedAt = now;
    await live.put(vault, JSON.stringify(next));
  }

  await saveConnection(live, vault, { ...connection, fetchedTo: today(), lastFetchAt: now });
  return { read: incoming.length, added: added.length, from };
}

async function fetchForOne(req, res) {
  const live = store();
  if (!live) return notConfigured(res);

  const body = await readBody(req);
  const problem = checkCode(body && body.code);
  if (problem) return json(res, 400, { error: "bad-code", message: problem });

  const vault = vaultKey(body.code.trim());
  const connection = await loadConnection(live, vault);
  if (!connection) return json(res, 409, { ok: false, message: "This vault has no bank connected yet." });

  try {
    const result = await pullInto(live, vault, connection);
    return json(res, 200, { ok: true, ...result });
  } catch (err) {
    console.error("bank fetch failed:", err.status || "", err.message);
    // A consent that has run out is the one failure worth naming: it is fixed
    // by reconnecting, and nothing else will fix it.
    const expired = err.status === 401 || err.status === 403;
    return json(res, 502, {
      ok: false,
      expired,
      message: expired ? "The bank wants you to authorise again." : err.message,
    });
  }
}

/** The nightly run. Needs no phrase: every connection is already stored. */
async function fetchForEveryone(req, res) {
  const secret = process.env.CRON_SECRET;
  const offered = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (secret && offered !== secret) {
    return json(res, 200, { ok: true, dryRun: true, message: "No secret, so nothing was fetched." });
  }

  const live = store();
  if (!live) return notConfigured(res);

  const report = [];
  for (const connection of await listConnections(live)) {
    try {
      const result = await pullInto(live, connection.vault, connection);
      report.push({ added: result.added, read: result.read });
    } catch (err) {
      console.error("nightly bank fetch failed:", err.status || "", err.message);
      report.push({ failed: err.status === 401 || err.status === 403 ? "needs reauthorising" : err.message });
    }
  }

  return json(res, 200, { ok: true, connections: report.length, report });
}

/* ---------- Odds and ends ---------- */

const today = () => new Date().toISOString().slice(0, 10);

/** Plain-date arithmetic, with no time zone anywhere near it. */
function shiftDate(date, days) {
  const [y, m, d] = String(date).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function safeParse(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (err) {
    return null;
  }
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (req.method === "GET") {
    const url = new URL(req.url, "http://localhost");
    return { code: url.searchParams.get("code") || "" };
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) return {};
    chunks.push(chunk);
  }
  return safeParse(Buffer.concat(chunks).toString("utf8")) || {};
}
