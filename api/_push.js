/**
 * Web Push, by hand.
 *
 * Sending a notification to a device whose browser is shut means speaking two
 * specifications: RFC 8292 for proving to the push service who we are, and
 * RFC 8291 for encrypting the payload so the push service, which relays it,
 * cannot read it. Node's crypto has every primitive both of them need, so
 * this file is the whole of it and there is nothing to install.
 *
 * The keys live in two environment variables. tools/vapid-keys.mjs prints a
 * fresh pair; they are per-deployment and changing them invalidates every
 * subscription, so once set they stay set.
 */

import { createECDH, createHash, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, createCipheriv, sign as signWith } from "node:crypto";

const CURVE = "prime256v1";
const JWT_LIFETIME = 12 * 3600;   // RFC 8292 caps this at 24 hours.
const RECORD_SIZE = 4096;

/* ---------- base64url ---------- */

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (text) => Buffer.from(String(text), "base64url");

/* ---------- Keys ---------- */

/** A fresh VAPID pair, as the two strings the environment variables hold. */
export function generateVapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: CURVE });
  const jwk = privateKey.export({ format: "jwk" });
  return {
    publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])),
    privateKey: jwk.d,
    _check: publicKey,
  };
}

/**
 * Checks the configured pair before anything trusts it.
 *
 * This exists because the two values are both opaque strings and the public
 * one is served to the app, so pasting them the wrong way round publishes the
 * private key and breaks subscription at the same time -- with nothing on
 * either side saying why. A public key is a 65-byte uncompressed point starting
 * 0x04 and a private key is the 32-byte scalar, which is enough to tell them
 * apart, and deriving the point from the scalar proves they are actually a pair.
 */
export function vapidReport() {
  const publicKey = process.env.VAPID_PUBLIC_KEY || "";
  const privateKey = process.env.VAPID_PRIVATE_KEY || "";
  const nothing = { configured: false, publicKey: "" };

  if (!publicKey || !privateKey) {
    return { ...nothing, problem: "VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are not both set." };
  }

  const point = unb64u(publicKey);
  const scalar = unb64u(privateKey);

  if (point.length === 32 && scalar.length === 65) {
    return {
      ...nothing,
      problem:
        "VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are the wrong way round. " +
        "Swap the two values. Because the private key was served publicly while " +
        "this was so, replace the pair with a fresh one rather than reusing it.",
    };
  }
  if (point.length !== 65 || point[0] !== 4) {
    return {
      ...nothing,
      problem: `VAPID_PUBLIC_KEY is not a public key: expected 65 bytes beginning 0x04, got ${point.length}.`,
    };
  }
  if (scalar.length !== 32) {
    return {
      ...nothing,
      problem: `VAPID_PRIVATE_KEY is not a private key: expected 32 bytes, got ${scalar.length}.`,
    };
  }

  try {
    const ecdh = createECDH(CURVE);
    ecdh.setPrivateKey(scalar);
    if (!ecdh.getPublicKey().equals(point)) {
      return { ...nothing, problem: "VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are not a pair." };
    }
  } catch (err) {
    return { ...nothing, problem: "VAPID_PRIVATE_KEY is not a usable P-256 key." };
  }

  return { configured: true, publicKey, problem: "" };
}

export function vapidKeys() {
  const report = vapidReport();
  if (!report.configured) return null;
  return {
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
    subject: process.env.VAPID_SUBJECT || "mailto:remembre@example.com",
  };
}

/**
 * The private key arrives as the raw scalar and the public key as the raw
 * point, so the x and y halves of the point rebuild the JWK the signer wants.
 */
function privateKeyObject({ publicKey, privateKey }) {
  const point = unb64u(publicKey);
  if (point.length !== 65 || point[0] !== 4) throw new Error("VAPID_PUBLIC_KEY is not a P-256 point");
  return createPrivateKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      d: privateKey,
      x: b64u(point.subarray(1, 33)),
      y: b64u(point.subarray(33, 65)),
    },
  });
}

/* ---------- RFC 8292: who is asking ---------- */

/** The Authorization header a push service checks before accepting anything. */
export function vapidHeader(endpoint, keys) {
  const audience = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64u(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + JWT_LIFETIME,
    sub: keys.subject,
  }));

  // ES256 wants the raw r||s pair, not the DER wrapper Node signs with by
  // default; ieee-p1363 is that raw form.
  const signature = signWith(
    "sha256",
    Buffer.from(`${header}.${claims}`),
    { key: privateKeyObject(keys), dsaEncoding: "ieee-p1363" }
  );

  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${keys.publicKey}`;
}

/* ---------- RFC 8291: what only the device can read ---------- */

/**
 * Encrypts one payload for one subscription, returning the exact bytes that
 * go in the request body: a header carrying the salt and our public key, then
 * a single AES-128-GCM record.
 */
export function encryptPayload(payload, { p256dh, auth }) {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  if (uaPublic.length !== 65) throw new Error("subscription key is not a P-256 point");
  if (authSecret.length !== 16) throw new Error("subscription auth secret is not 16 bytes");

  const ephemeral = createECDH(CURVE);
  const asPublic = ephemeral.generateKeys();
  const shared = ephemeral.computeSecret(uaPublic);

  // The device's key and ours both go into the info string, so a record can
  // only be read by the device it was built for.
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0"), uaPublic, asPublic,
  ]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, keyInfo, 32));

  const salt = randomBytes(16);
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));

  // 0x02 marks the last record. There is only ever one.
  const plaintext = Buffer.concat([Buffer.from(payload, "utf8"), Buffer.from([2])]);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  const head = Buffer.alloc(21);
  salt.copy(head, 0);
  head.writeUInt32BE(RECORD_SIZE, 16);
  head.writeUInt8(asPublic.length, 20);

  return Buffer.concat([head, asPublic, body]);
}

/* ---------- Sending ---------- */

/**
 * Hands one notification to one push service.
 *
 * A 404 or 410 means the device has thrown the subscription away -- the app
 * was deleted, or the browser rotated it -- and the caller should forget it
 * rather than retrying forever.
 */
export async function sendPush(subscription, payload, { ttl = 24 * 3600 } = {}) {
  const keys = vapidKeys();
  if (!keys) throw new Error("No VAPID keys are configured.");

  const body = encryptPayload(payload, subscription);
  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: vapidHeader(subscription.endpoint, keys),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttl),
      Urgency: "normal",
    },
    body,
  });

  return {
    ok: res.ok,
    status: res.status,
    gone: res.status === 404 || res.status === 410,
    detail: res.ok ? "" : (await res.text().catch(() => "")).slice(0, 300),
  };
}

/* ---------- Where subscriptions live ---------- */

/*
  One key per device, plus an index so the daily run can find them all. A
  handful of devices does not need anything cleverer, and the index keeps the
  store interface down to get and put.
*/

export const PUSH_INDEX = "push_index";
export const subscriptionId = (endpoint) =>
  createHash("sha256").update(endpoint, "utf8").digest("hex").slice(0, 32);
export const subscriptionKey = (id) => `push_${id}`;

async function readJson(store, key, fallback) {
  const raw = await store.get(key);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch (err) {
    return fallback;
  }
}

export async function listSubscriptions(store) {
  const index = await readJson(store, PUSH_INDEX, []);
  const ids = Array.isArray(index) ? index : [];
  const found = await Promise.all(ids.map((id) => readJson(store, subscriptionKey(id), null)));
  return found.map((record, i) => (record ? { id: ids[i], ...record } : null)).filter(Boolean);
}

export async function saveSubscription(store, id, record) {
  await store.put(subscriptionKey(id), JSON.stringify(record));
  const index = await readJson(store, PUSH_INDEX, []);
  const ids = Array.isArray(index) ? index : [];
  if (!ids.includes(id)) await store.put(PUSH_INDEX, JSON.stringify([...ids, id]));
}

export async function forgetSubscription(store, id) {
  await store.put(subscriptionKey(id), "");
  const index = await readJson(store, PUSH_INDEX, []);
  const ids = Array.isArray(index) ? index : [];
  await store.put(PUSH_INDEX, JSON.stringify(ids.filter((held) => held !== id)));
}
