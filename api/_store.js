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

/*
  Finding the credentials is its own small problem. A Redis store attached
  through Vercel's marketplace names its variables after a prefix chosen at the
  moment it was connected -- KV_REST_API_URL, UPSTASH_REDIS_REST_URL and
  STORAGE_REST_API_URL are all the same URL under three different prefixes --
  and a store that was attached correctly but named unexpectedly looks exactly
  like no store at all.

  So rather than a list of names, look for the shape: any variable whose name
  ends in one of these, paired with the matching token under the same prefix.
*/
const REST_PAIRS = [
  ["_REST_API_URL", "_REST_API_TOKEN"],
  ["_REDIS_REST_URL", "_REDIS_REST_TOKEN"],
  ["_REST_URL", "_REST_TOKEN"],
];

/** The first complete URL-and-token pair in the environment, whatever its prefix. */
function findRestPair() {
  const names = Object.keys(process.env);
  for (const [urlSuffix, tokenSuffix] of REST_PAIRS) {
    for (const name of names.sort()) {
      if (!name.endsWith(urlSuffix)) continue;
      const token = `${name.slice(0, -urlSuffix.length)}${tokenSuffix}`;
      const url = process.env[name];
      // A rediss:// URL is the TCP endpoint, not the REST one, and needs a
      // client we do not have. Only the HTTPS endpoint is usable from here.
      if (url && /^https:\/\//.test(url) && process.env[token]) {
        return { url, token: process.env[token], names: [name, token] };
      }
    }
  }
  return null;
}

/**
 * The drivers, most preferred first. Each one says how to tell whether it can
 * run, and what to set if it cannot, so /api/status can explain itself without
 * ever reporting a value.
 */
const DRIVERS = [
  {
    name: "redis",
    label: "Upstash Redis",
    needs: "A REST URL and token pair, under any prefix: KV_REST_API_URL and KV_REST_API_TOKEN, UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN, or the same two suffixes behind whatever prefix your store was connected with.",
    detect: findRestPair,
    build: redisDriver,
  },
  {
    name: "blob",
    label: "Vercel Blob",
    needs: "BLOB_READ_WRITE_TOKEN",
    detect: () => (process.env.BLOB_READ_WRITE_TOKEN ? {} : null),
    build: blobDriver,
  },
  {
    name: "github",
    label: "a GitHub repository",
    needs: "REMEMBRE_GITHUB_TOKEN and REMEMBRE_GITHUB_REPO",
    detect: () =>
      process.env.REMEMBRE_GITHUB_TOKEN && process.env.REMEMBRE_GITHUB_REPO ? {} : null,
    build: githubDriver,
  },
  {
    name: "files",
    label: "a directory on disk",
    needs: "REMEMBRE_DATA_DIR",
    detect: () => (process.env.REMEMBRE_DATA_DIR ? {} : null),
    build: fileDriver,
  },
];

/** The first driver whose credentials are all present, or null. */
export function store() {
  for (const driver of DRIVERS) {
    const found = driver.detect();
    if (found) return { name: driver.name, label: driver.label, ...driver.build(found) };
  }
  return null;
}

/*
  Which variable names are worth mentioning when nothing matched. Only names
  are ever reported, never values, and only names shaped like a credential a
  store would set: listing the whole environment would be a leak waiting to
  happen.
*/
const STORAGE_NAME =
  /^(KV|UPSTASH|REDIS|BLOB|EDGE_CONFIG|POSTGRES|DATABASE|NEON|SUPABASE|STORAGE|REMEMBRE)_|_(URL|TOKEN|REST_API_URL|REST_API_TOKEN|CONNECTION_STRING)$/;

/** What /api/status reports: never a value, only whether one is set. */
export function storeReport() {
  const live = store();
  const pair = findRestPair();
  return {
    configured: Boolean(live),
    using: live ? live.name : null,
    label: live ? live.label : null,
    drivers: DRIVERS.map((driver) => ({
      name: driver.name,
      label: driver.label,
      needs: driver.needs,
      ready: Boolean(driver.detect()),
    })),
    // Which two variables the Redis driver settled on, so a store that was
    // attached under an unexpected prefix can be confirmed at a glance.
    matched: pair ? pair.names : [],
    // Every credential-shaped variable this deployment can see. When a store
    // is attached and nothing matched, this is the answer.
    seen: Object.keys(process.env).filter((name) => STORAGE_NAME.test(name)).sort(),
  };
}

/* ---------- Upstash Redis over its REST API ---------- */

function redisDriver({ url, token }) {
  const base = String(url).replace(/\/+$/, "");
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
