import { checkCode, cors, json, notConfigured, store, vaultKey } from "./_store.js";
import {
  asTransaction, bankAuthorise, bankBalances, bankFetch, bankReport, bankTransactions, CONSENT_DAYS,
} from "./_bank.js";
import {
  handoverKey, listConnections, loadConnection, newNonce, noteOutcome, onlyNewRows,
  readJournal, saveConnection,
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

  if (action === "aspsp") return namesForMbank(req, res);
  if (action === "preflight") return preflight(req, res);
  if (action === "connect") return startConnecting(req, res);
  if (action === "status") return connectionStatus(req, res);
  if (action === "fetch") return fetchForOne(req, res);
  if (action === "daily") return fetchForEveryone(req, res);
  if (action === "journal") return journal(req, res);
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
    await noteOutcome(live, "sent-to-bank", `consent asked for until ${validUntil}`);
    return json(res, 200, { ok: true, url, validUntil, days: CONSENT_DAYS });
  } catch (err) {
    console.error("bank connect failed:", err.status || "", err.message);
    await noteOutcome(live, "connect-failed", `${err.status || "no status"}: ${String(err.message).slice(0, 140)}`);
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
    // What the bank last said was in the account. Stored rather than fetched
    // here: status is called whenever the half is opened, and a balance call
    // per visit spends somebody's rate limit for a figure that only moves when
    // a transaction does.
    balance: held.balance || null,
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
/** Who is asking, when it is the reader rather than the schedule. */
function psuOf(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = forwarded || req.headers["x-real-ip"] || "";
  if (!ip) return null;
  return { ip, agent: req.headers["user-agent"] || "Get a grip" };
}

async function pullInto(live, vault, connection, psu = null) {
  const from = connection.fetchedTo
    ? shiftDate(connection.fetchedTo, -OVERLAP_DAYS)
    : shiftDate(today(), -HISTORY_DAYS);

  const incoming = [];
  for (const account of connection.accounts) {
    const rows = await bankTransactions(account.uid, from, psu);
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

  /*
    The balance is asked for on the same trip, because this is the moment it
    can have changed. A bank that will not answer is not an error worth
    failing the fetch over -- the transactions are already in -- so the last
    known figure is kept and marked with when it was true.
  */
  let balance = connection.balance || null;
  try {
    const read = [];
    for (const account of connection.accounts) {
      const figure = await bankBalances(account.uid, psu);
      if (figure) read.push({ account: account.name, iban: account.iban, ...figure });
    }
    if (read.length > 0) {
      balance = {
        amount: read.reduce((sum, row) => sum + row.amount, 0),
        currency: read[0].currency,
        type: read.length === 1 ? read[0].type : "SUM",
        at: read[0].at || today(),
        readAt: now,
        accounts: read,
      };
    }
  } catch (err) {
    console.error("bank balance failed:", err.status || "", err.message);
  }

  await saveConnection(live, vault, {
    ...connection, fetchedTo: today(), lastFetchAt: now, balance,
  });
  return { read: incoming.length, added: added.length, from, balance };
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
    // The reader is on the page waiting for this, so it is attended and does
    // not come out of the four the schedule has to live within.
    const result = await pullInto(live, vault, connection, psuOf(req));
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

/**
 * What the round trips through the bank have been doing.
 *
 * Outcomes and short reasons, with a count of the connections stored. No
 * vault keys, no account numbers, no codes -- it answers "did the connecting
 * work, and if not where did it stop", which is the question that cannot be
 * answered from a page that looks unchanged.
 */
async function journal(req, res) {
  const live = store();
  if (!live) return notConfigured(res);
  const connections = await listConnections(live);
  return json(res, 200, {
    ok: true,
    connections: connections.length,
    accounts: connections.reduce((sum, held) => sum + held.accounts.length, 0),
    entries: await readJournal(live),
  });
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

/* ---------- Checks that need no bank login ---------- */

/*
  The authorisation names the bank by a string that has to match their
  catalogue exactly. "mBank" is a guess until it is read back, and a wrong one
  fails at the moment the reader taps Connect -- the worst time to find out.
*/
async function namesForMbank(req, res) {
  try {
    const answer = await bankFetch("/aspsps?country=PL");
    const banks = Array.isArray(answer && answer.aspsps) ? answer.aspsps : [];
    return json(res, 200, {
      ok: true,
      matches: banks
        .filter((bank) => /mbank/i.test(bank.name || ""))
        .map((bank) => ({
          name: bank.name,
          country: bank.country,
          psuTypes: bank.psu_types || bank.psuTypes || null,
          beta: Boolean(bank.beta),
        })),
    });
  } catch (err) {
    return json(res, 502, { ok: false, message: err.message });
  }
}

/**
 * Starts a real authorisation and throws the result away.
 *
 * It proves the three things that can only fail at the tap: that the bank name
 * matches their catalogue, that this deployment's callback is a registered
 * redirect URL, and that a 180-day consent is accepted. No bank login is
 * involved -- the URL that comes back is simply not followed.
 */
async function preflight(req, res) {
  try {
    const { url, validUntil } = await bankAuthorise({
      redirectUrl: redirectUrl(req),
      state: newNonce(),
    });
    return json(res, 200, {
      ok: true,
      wouldSendYouTo: new URL(url).host,
      consentDays: CONSENT_DAYS,
      validUntil,
      redirectUrl: redirectUrl(req),
    });
  } catch (err) {
    return json(res, 502, {
      ok: false,
      status: err.status || 0,
      message: err.message,
      detail: err.detail || "",
      redirectUrl: redirectUrl(req),
    });
  }
}
