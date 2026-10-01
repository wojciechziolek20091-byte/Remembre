/*
  Talking to Enable Banking.

  Every call carries a short-lived JWT signed with the private key that the
  Control Panel generated in the reader's browser: RS256, the application id in
  the "kid" header, fixed issuer and audience. The key lives in an environment
  variable and never leaves this file -- nothing here returns it, logs it, or
  puts it in an error message.

  Read-only by construction. Nothing in this file or in api/bank.js can
  initiate a payment: the only endpoints it knows are the ones that list banks,
  start an authorisation, and read accounts and transactions.
*/

import { createPrivateKey, randomUUID, sign as signWith } from "node:crypto";

const BASE = "https://api.enablebanking.com";
const TOKEN_SECONDS = 600;          // Far inside the 24-hour ceiling.

const b64u = (value) => Buffer.from(value).toString("base64url");

/*
  A PEM pasted into a settings box often arrives with its line breaks turned
  into the two characters \ and n, or with the whole thing on one line. Both are
  recoverable, and recovering them is kinder than refusing a key that is
  actually correct.
*/
function repairPem(raw) {
  let text = String(raw).trim().replace(/\\n/g, "\n");
  if (text.includes("\n")) return text;

  const match = /^(-----BEGIN [A-Z ]+-----)(.*)(-----END [A-Z ]+-----)$/s.exec(text);
  if (!match) return text;
  const body = match[2].replace(/\s+/g, "").replace(/(.{64})/g, "$1\n");
  return `${match[1]}\n${body.trim()}\n${match[3]}\n`;
}

/**
 * The configured credentials, or null. Checked rather than trusted: a key that
 * is the wrong kind, or truncated, should be named as such long before a
 * nightly job fails with something cryptic.
 */
export function bankReport() {
  const appId = (process.env.ENABLE_BANKING_APP_ID || "").trim();
  const rawKey = process.env.ENABLE_BANKING_PRIVATE_KEY || "";
  const nothing = { configured: false };

  if (!appId && !rawKey) {
    return { ...nothing, problem: "ENABLE_BANKING_APP_ID and ENABLE_BANKING_PRIVATE_KEY are not set." };
  }
  if (!appId) return { ...nothing, problem: "ENABLE_BANKING_APP_ID is not set." };
  if (!rawKey) return { ...nothing, problem: "ENABLE_BANKING_PRIVATE_KEY is not set." };

  if (!/^[0-9a-f-]{20,}$/i.test(appId)) {
    return { ...nothing, problem: "ENABLE_BANKING_APP_ID does not look like an application id." };
  }

  const pem = repairPem(rawKey);
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) {
    return {
      ...nothing,
      problem: "ENABLE_BANKING_PRIVATE_KEY is not a PEM private key: it should begin -----BEGIN PRIVATE KEY-----.",
    };
  }

  let key;
  try {
    key = createPrivateKey(pem);
  } catch (err) {
    return {
      ...nothing,
      problem: "ENABLE_BANKING_PRIVATE_KEY could not be read. A line break lost on the way into the settings box is the usual cause.",
    };
  }

  // Enable Banking signs with RS256 and nothing else, so an EC key -- easy to
  // generate by mistake -- would fail at the first call rather than here.
  if (key.asymmetricKeyType !== "rsa") {
    return {
      ...nothing,
      problem: `ENABLE_BANKING_PRIVATE_KEY is an ${key.asymmetricKeyType} key; Enable Banking signs with RSA.`,
    };
  }

  return { configured: true, problem: "", keyType: "rsa", keyBits: key.asymmetricKeyDetails?.modulusLength || 0 };
}

export function bankCredentials() {
  if (!bankReport().configured) return null;
  return {
    appId: process.env.ENABLE_BANKING_APP_ID.trim(),
    key: createPrivateKey(repairPem(process.env.ENABLE_BANKING_PRIVATE_KEY)),
  };
}

/** A fresh token per call: they are cheap, and a stale one is a silent 401. */
function bankToken({ appId, key }) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ typ: "JWT", alg: "RS256", kid: appId }));
  const claims = b64u(JSON.stringify({
    iss: "enablebanking.com",
    aud: "api.enablebanking.com",
    iat: now,
    exp: now + TOKEN_SECONDS,
  }));
  const signature = signWith("sha256", Buffer.from(`${header}.${claims}`), key);
  return `${header}.${claims}.${b64u(signature)}`;
}

/**
 * One call to Enable Banking. Errors carry the status and whatever the API
 * said, trimmed -- never the token, never the key.
 */
export async function bankFetch(path, { method = "GET", body = null } = {}) {
  const credentials = bankCredentials();
  if (!credentials) throw new Error("Enable Banking is not configured.");

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${bankToken(credentials)}`,
      "Content-Type": "application/json",
      ...(method === "POST" ? { "X-Request-Id": randomUUID() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (err) {
    parsed = null;
  }

  if (!res.ok) {
    const error = new Error(
      (parsed && (parsed.message || parsed.detail || parsed.error)) || `Enable Banking answered ${res.status}.`
    );
    error.status = res.status;
    error.detail = text.slice(0, 300);
    throw error;
  }

  return parsed;
}
