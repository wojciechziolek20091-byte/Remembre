import {
  checkCode, cors, feedKey, feedToken, json, notConfigured, store, vaultKey,
} from "./_store.js";

const MAX_BODY = 2 * 1024 * 1024;   // A year of tasks is a few tens of kilobytes.
const COLLECTIONS = ["tasks", "coursework", "sessions"];

/**
 * The meeting point for a reader's devices.
 *
 *   GET  /api/sync?code=...      what the server holds
 *   POST /api/sync               merge this device's copy into it
 *
 * A POST is merged rather than overwritten, so a device that has been offline
 * for a week cannot wipe out what the other one did in the meantime: within
 * each collection the newer updatedAt wins, record by record. The merged
 * result comes back in the response, which is what the pushing device adopts.
 */
export default async function handler(req, res) {
  if (cors(req, res)) return;

  const live = store();
  if (!live) return notConfigured(res);

  try {
    if (req.method === "GET") return await read(req, res, live);
    if (req.method === "POST") return await write(req, res, live);
    return json(res, 405, { error: "method-not-allowed" });
  } catch (err) {
    console.error("sync failed:", err);
    return json(res, 502, {
      error: "store-unavailable",
      message: "The store did not answer. Nothing was lost; try again.",
    });
  }
}

async function read(req, res, live) {
  const code = new URL(req.url, "http://localhost").searchParams.get("code") || "";
  const problem = checkCode(code);
  if (problem) return json(res, 400, { error: "bad-code", message: problem });

  const raw = await live.get(vaultKey(code.trim()));
  const vault = raw ? safeParse(raw) : null;
  return json(res, 200, {
    ok: true,
    found: Boolean(vault),
    updatedAt: vault ? vault.updatedAt || "" : "",
    feed: feedToken(code.trim()),
    vault: vault ? stripMeta(vault) : emptyVault(),
  });
}

async function write(req, res, live) {
  const body = await readBody(req);
  if (body === null) {
    return json(res, 413, { error: "too-large", message: "That copy is too big to sync." });
  }

  const problem = checkCode(body && body.code);
  if (problem) return json(res, 400, { error: "bad-code", message: problem });

  const code = body.code.trim();
  const key = vaultKey(code);

  const existing = safeParse(await live.get(key)) || emptyVault();
  const incoming = body.vault && typeof body.vault === "object" ? body.vault : {};

  const merged = emptyVault();
  const counts = {};
  COLLECTIONS.forEach((name) => {
    const result = mergeCollection(existing[name], incoming[name]);
    merged[name] = result.records;
    counts[name] = result.changed;
  });
  merged.updatedAt = new Date().toISOString();

  await live.put(key, JSON.stringify(merged));

  // The feed is whatever the last device built, stored under its own key so a
  // calendar subscription can read it without ever seeing the vault.
  const token = feedToken(code);
  if (typeof body.ics === "string" && body.ics.includes("BEGIN:VCALENDAR")) {
    await live.put(feedKey(token), body.ics);
  }

  return json(res, 200, {
    ok: true,
    updatedAt: merged.updatedAt,
    feed: token,
    changed: counts,
    vault: stripMeta(merged),
  });
}

/* ---------- Merging ---------- */

/**
 * Last write wins, per record, by updatedAt. Tombstones are records too, so a
 * delete on one device survives the next push from the other.
 */
function mergeCollection(mine, theirs) {
  const records = new Map();
  (Array.isArray(mine) ? mine : []).forEach((record) => {
    if (record && typeof record.id === "string") records.set(record.id, record);
  });

  let changed = 0;
  (Array.isArray(theirs) ? theirs : []).forEach((record) => {
    if (!record || typeof record.id !== "string") return;
    const held = records.get(record.id);
    if (!held || String(record.updatedAt || "") > String(held.updatedAt || "")) {
      records.set(record.id, record);
      changed += 1;
    }
  });

  return { records: [...records.values()], changed };
}

/* ---------- Odds and ends ---------- */

const emptyVault = () => ({ tasks: [], coursework: [], sessions: [], updatedAt: "" });

function stripMeta(vault) {
  const out = {};
  COLLECTIONS.forEach((name) => {
    out[name] = Array.isArray(vault[name]) ? vault[name] : [];
  });
  return out;
}

function safeParse(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (err) {
    return null;
  }
}

/** Vercel usually hands us a parsed body; this covers the case where it has not. */
async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return safeParse(req.body);

  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk);
  }
  return safeParse(Buffer.concat(chunks).toString("utf8"));
}
