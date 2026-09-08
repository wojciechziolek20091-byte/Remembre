/**
 * Remembre still keeps everything on the reader's device. This server exists
 * for the two things a device cannot do alone: let an iPad and a phone meet in
 * the middle, and hand a calendar app a URL it can poll by itself.
 *
 * There is no database of our own here, and nothing to run locally. Whichever
 * of the stores below the deployment has credentials for is the one that gets
 * used, in this order. If none are configured every route says so plainly
 * rather than pretending to have saved something.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const GITHUB_API = "https://api.github.com";
const BLOB_API = "https://blob.vercel-storage.com";

/* ---------- Which store are we talking to? ---------- */

/**
 * The drivers, most preferred first.
 *
 * Each thing a driver needs is a list of names rather than one name, because
 * the same credential arrives under different names depending on how the store
 * was attached: the Vercel-managed Redis calls it KV_REST_API_URL, the Upstash
 * integration calls it UPSTASH_REDIS_REST_URL, and either is the same URL.
 * Whichever name is set is the one used.
 */
const DRIVERS = [
  {
    name: "redis",
    label: "Upstash Redis",
    env: [
      ["KV_REST_API_URL", "UPSTASH_REDIS_REST_URL", "REDIS_REST_URL"],
      ["KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN", "REDIS_REST_TOKEN"],
    ],
    build: redisDriver,
  },
  {
    name: "blob",
    label: "Vercel Blob",
    env: [["BLOB_READ_WRITE_TOKEN"]],
    build: blobDriver,
  },
  {
    name: "github",
    label: "a GitHub repository",
    env: [["REMEMBRE_GITHUB_TOKEN"], ["REMEMBRE_GITHUB_REPO"]],
    build: githubDriver,
  },
  {
    name: "files",
    label: "a directory on disk",
    env: [["REMEMBRE_DATA_DIR"]],
    build: fileDriver,
  },
];

/** The first name in the list that is actually set, or "". */
function pick(names) {
  const found = names.find((name) => process.env[name]);
  return found ? process.env[found] : "";
}

const satisfied = (driver) => driver.env.every((names) => Boolean(pick(names)));

/** The first driver whose credentials are all present, or null. */
export function store() {
  const chosen = DRIVERS.find(satisfied);
  return chosen ? { name: chosen.name, label: chosen.label, ...chosen.build() } : null;
}

/*
  Which variables count as worth mentioning when nothing matched. Only the
  names are ever reported, never a value, and only names that look like they
  belong to a store: a blanket listing of the environment would be a leak
  waiting to happen.
*/
const STORAGE_NAME = /^(KV|UPSTASH|REDIS|BLOB|EDGE_CONFIG|POSTGRES|DATABASE|NEON|SUPABASE|REMEMBRE)_?/;

/** What /api/status reports: never a value, only whether one is set. */
export function storeReport() {
  const live = store();
  return {
    configured: Boolean(live),
    using: live ? live.name : null,
    label: live ? live.label : null,
    drivers: DRIVERS.map((driver) => ({
      name: driver.name,
      label: driver.label,
      needs: driver.env.map((names) => names[0]),
      accepts: driver.env.map((names) => names.join(" or ")),
      ready: satisfied(driver),
    })),
    // The name of every storage-shaped variable this deployment can see. When
    // a store has been attached and nothing matched, this is the answer: it
    // says what the integration actually called things.
    seen: Object.keys(process.env).filter((name) => STORAGE_NAME.test(name)).sort(),
  };
}

/* ---------- Upstash Redis over its REST API ---------- */

function redisDriver() {
  const base = String(pick(["KV_REST_API_URL", "UPSTASH_REDIS_REST_URL", "REDIS_REST_URL"]))
    .replace(/\/+$/, "");
  const token = pick(["KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN", "REDIS_REST_TOKEN"]);
  const auth = { Authorization: `Bearer ${token}` };

  return {
    async get(key) {
      const res = await fetch(`${base}/get/${encodeURIComponent(key)}`, { headers: auth });
      if (!res.ok) throw new Error(`Redis read failed (${res.status})`);
      const body = await res.json();
      return body && typeof body.result === "string" ? body.result : null;
    },
    async put(key, value) {
      const res = await fetch(`${base}/set/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "text/plain" },
        body: value,
      });
      if (!res.ok) throw new Error(`Redis write failed (${res.status})`);
    },
  };
}

/* ---------- Vercel Blob over its REST API ---------- */

/*
  Blob URLs carry a random store id we do not know up front, so a read is a
  listing by prefix followed by a fetch of the public URL it hands back. The
  prefix is the whole key, so the listing is one item long.
*/
function blobDriver() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const auth = { Authorization: `Bearer ${token}` };
  const path = (key) => `remembre/${key}`;

  return {
    async get(key) {
      const url = `${BLOB_API}/?prefix=${encodeURIComponent(path(key))}&limit=1`;
      const listed = await fetch(url, { headers: auth });
      if (!listed.ok) throw new Error(`Blob listing failed (${listed.status})`);
      const body = await listed.json();
      const first = body && Array.isArray(body.blobs) ? body.blobs[0] : null;
      if (!first || first.pathname !== path(key)) return null;
      const res = await fetch(first.url, { cache: "no-store" });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Blob read failed (${res.status})`);
      return await res.text();
    },
    async put(key, value) {
      const res = await fetch(`${BLOB_API}/${encodeURI(path(key))}`, {
        method: "PUT",
        headers: {
          ...auth,
          "x-api-version": "7",
          "x-content-type": "text/plain",
          "x-add-random-suffix": "0",
          "x-cache-control-max-age": "0",
        },
        body: value,
      });
      if (!res.ok) throw new Error(`Blob write failed (${res.status})`);
    },
  };
}

/* ---------- A GitHub repository as a store ---------- */

/*
  The slowest of the three and the only one that needs no storage product at
  all: a fine-grained token with contents write on one repository. Writing
  needs the current blob sha, so a write is a read followed by a PUT.
*/
function githubDriver() {
  const token = process.env.REMEMBRE_GITHUB_TOKEN;
  const repo = process.env.REMEMBRE_GITHUB_REPO;
  const branch = process.env.REMEMBRE_GITHUB_BRANCH || "main";
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "remembre",
  };
  const path = (key) => `remembre-data/${key}`;
  const url = (key) => `${GITHUB_API}/repos/${repo}/contents/${encodeURI(path(key))}`;

  async function head(key) {
    const res = await fetch(`${url(key)}?ref=${encodeURIComponent(branch)}`, {
      headers,
      cache: "no-store",
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub read failed (${res.status})`);
    return await res.json();
  }

  return {
    async get(key) {
      const file = await head(key);
      if (!file || typeof file.content !== "string") return null;
      return Buffer.from(file.content, "base64").toString("utf8");
    },
    async put(key, value) {
      const existing = await head(key);
      const res = await fetch(url(key), {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `Remembre: update ${key}`,
          content: Buffer.from(value, "utf8").toString("base64"),
          branch,
          ...(existing && existing.sha ? { sha: existing.sha } : {}),
        }),
      });
      if (!res.ok) throw new Error(`GitHub write failed (${res.status})`);
    },
  };
}

/* ---------- A directory on disk ---------- */

/*
  For running the whole thing locally, and for any host with a writable disk
  that outlives a request. On Vercel's serverless filesystem it would not, so
  it sits last and is only ever reached when nothing else is configured.
*/
function fileDriver() {
  const dir = process.env.REMEMBRE_DATA_DIR;
  const file = (key) => join(dir, `${key.replace(/[^a-z0-9_.-]/gi, "_")}.txt`);

  return {
    async get(key) {
      try {
        return await readFile(file(key), "utf8");
      } catch (err) {
        if (err && err.code === "ENOENT") return null;
        throw err;
      }
    },
    async put(key, value) {
      await mkdir(dir, { recursive: true });
      await writeFile(file(key), value, "utf8");
    },
  };
}

/* ---------- Keys ---------- */

const hash = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * The sync code is the only secret, so it never becomes a storage key itself.
 * The vault key and the feed token are separate hashes of it: knowing the feed
 * URL therefore reveals the calendar and nothing else, and cannot be walked
 * back to the code or to the vault.
 */
export const vaultKey = (code) => `vault_${hash(`remembre.vault:${code}`)}`;
export const feedToken = (code) => hash(`remembre.feed:${code}`).slice(0, 32);
export const feedKey = (token) => `feed_${token}`;

/** Sync codes have to be long enough to be worth guessing. */
export function checkCode(code) {
  if (typeof code !== "string") return "A sync code is required.";
  const trimmed = code.trim();
  if (trimmed.length < 12) return "A sync code needs at least 12 characters.";
  if (trimmed.length > 200) return "That sync code is too long.";
  return null;
}

/* ---------- Shared response helpers ---------- */

export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

/** Every route is same-origin from the app, so one shared preflight will do. */
export function cors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}

export function notConfigured(res) {
  json(res, 503, {
    error: "no-store",
    message:
      "This Remembre server has no storage attached yet, so there is nothing to sync with. " +
      "See /api/status for what it is waiting for.",
  });
}
