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

  // Quotes wrapped round the value by a copy, or by a settings box being
  // helpful, are not part of the key.
  text = text.replace(/^["']|["']$/g, "").trim();

  /*
    Bare base64 with no armour: the key is there, it just lost its header and
    footer on the way. PKCS#8 is what a browser's SubtleCrypto exports, so
    that is what it is wrapped back into.
  */
  if (!text.includes("-----") && /^[A-Za-z0-9+/=\s]+$/.test(text) && text.replace(/\s/g, "").length > 100) {
    const body = text.replace(/\s/g, "").replace(/(.{64})/g, "$1\n");
    text = `-----BEGIN PRIVATE KEY-----\n${body.trim()}\n-----END PRIVATE KEY-----\n`;
  }

  if (text.includes("\n")) return text;

  const match = /^(-----BEGIN [A-Z ]+-----)(.*)(-----END [A-Z ]+-----)$/s.exec(text);
  if (!match) return text;
  const body = match[2].replace(/\s+/g, "").replace(/(.{64})/g, "$1\n");
  return `${match[1]}\n${body.trim()}\n${match[3]}\n`;
}

/**
 * The shape of a value, for when it is not what was expected. Lengths, counts
 * and yes-or-nos only: never a character of the value itself.
 */
function describeValue(raw) {
  const text = String(raw);
  return {
    length: text.length,
    lines: text.split("\n").length,
    startsWithDashes: text.trim().startsWith("-----"),
    mentionsBegin: /BEGIN/i.test(text),
    mentionsPrivate: /PRIVATE/i.test(text),
    mentionsPublic: /PUBLIC/i.test(text),
    looksLikeBase64: /^[A-Za-z0-9+/=\s]+$/.test(text.trim()) && text.trim().length > 100,
    looksLikeJson: text.trim().startsWith("{"),
    looksLikeUuid: /^[0-9a-f-]{20,40}$/i.test(text.trim()),
    hasQuotes: /^["']|["']$/.test(text.trim()),
  };
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
      // Enough to work out what was pasted instead, without reporting any of
      // it. A secret that is the wrong secret is still a secret.
      sawInstead: describeValue(rawKey),
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

/* ---------- Starting an authorisation ---------- */

/*
  EU rules let an account-information consent run for 180 days before the bank
  asks for strong authentication again. Asking for the maximum is the whole
  difference between re-authorising twice a year and re-authorising constantly:
  left to default, mBank offered a consent valid for a single day.
*/
export const CONSENT_DAYS = 180;

export async function bankAuthorise({ redirectUrl, state }) {
  const validUntil = new Date(Date.now() + CONSENT_DAYS * 86400000).toISOString();

  const answer = await bankFetch("/auth", {
    method: "POST",
    body: {
      access: { valid_until: validUntil },
      aspsp: { name: "mBank", country: "PL" },
      state,
      redirect_url: redirectUrl,
      psu_type: "personal",
    },
  });

  if (!answer || !answer.url) throw new Error("Enable Banking did not return somewhere to send you.");
  return { url: answer.url, validUntil };
}

/** Trades the code the bank sent back for a session, and the accounts on it. */
export async function bankSession(code) {
  const answer = await bankFetch("/sessions", { method: "POST", body: { code } });
  const accounts = Array.isArray(answer && answer.accounts) ? answer.accounts : [];

  return {
    sessionId: answer.session_id || "",
    // How many the bank named at all, as against how many were usable. An
    // empty consent and a consent whose accounts have no uid are different
    // problems with the same symptom.
    rawCount: accounts.length,
    accounts: accounts.map((account, index) => ({
      uid: account.uid || "",
      // Enough to recognise which account this is, never the full number.
      name: account.name || account.product || `Account ${index + 1}`,
      iban: account.account_id && account.account_id.iban
        ? `…${String(account.account_id.iban).slice(-4)}`
        : "",
      currency: account.currency || "",
    })).filter((account) => account.uid),
  };
}

/**
 * Every transaction on one account since a date. Follows the continuation key
 * to the end rather than stopping at the first page, which would quietly lose
 * the oldest part of a busy month.
 */
export async function bankTransactions(accountUid, dateFrom) {
  const rows = [];
  let continuation = "";

  for (let page = 0; page < 40; page += 1) {
    const query = new URLSearchParams({ date_from: dateFrom });
    if (continuation) query.set("continuation_key", continuation);

    const answer = await bankFetch(`/accounts/${encodeURIComponent(accountUid)}/transactions?${query}`);
    const batch = Array.isArray(answer && answer.transactions) ? answer.transactions : [];
    rows.push(...batch);

    continuation = (answer && answer.continuation_key) || "";
    if (!continuation) break;
  }

  return rows;
}

/* ---------- Making their shape into ours ---------- */

/** "12.49" and a debit indicator become -1249 grosze. */
function groszeOf(transaction) {
  const raw = transaction.transaction_amount || transaction.amount || {};
  const text = String(raw.amount != null ? raw.amount : raw);
  const value = Math.round(Number(text) * 100);
  if (!Number.isFinite(value)) return null;
  const credit = String(transaction.credit_debit_indicator || "").toUpperCase() === "CRDT";
  return credit ? Math.abs(value) : -Math.abs(value);
}

const textOf = (value) => (Array.isArray(value) ? value.join(" ") : String(value || ""))
  .replace(/\s+/g, " ").trim();

/**
 * One of their transactions in the shape the rest of the app already uses, so
 * a row that arrived by CSV and the same row fetched from the bank are the
 * same kind of thing.
 */
export function asTransaction(transaction) {
  const amount = groszeOf(transaction);
  if (amount === null) return null;

  const date = String(transaction.transaction_date || transaction.booking_date || transaction.value_date || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const other = amount < 0 ? transaction.creditor : transaction.debtor;

  return {
    date,
    booked: String(transaction.booking_date || date).slice(0, 10),
    description: textOf(transaction.bank_transaction_code && transaction.bank_transaction_code.description),
    title: textOf(transaction.remittance_information),
    counterparty: textOf(other && other.name),
    account: "",
    amount,
    balance: null,
  };
}

/* ---------- What is actually in the account ---------- */

/*
  A balance is not a sum of transactions, and treating it as one is how a money
  app ends up confidently wrong. The account has a figure; this asks for it.

  Banks publish several at once -- booked, available, expected -- and they
  disagree by whatever has not cleared yet. The one worth showing is what could
  be spent today, so interim-available is preferred, then closing-booked, then
  whatever came first. The type that was used is returned with it, because
  "1 842,10 zl available" and "1 842,10 zl booked" are different claims.
*/
const BALANCE_ORDER = ["ITAV", "CLAV", "XPCD", "CLBD", "PRCD", "OTHR"];

export async function bankBalances(accountUid) {
  const answer = await bankFetch(`/accounts/${encodeURIComponent(accountUid)}/balances`);
  const rows = Array.isArray(answer && answer.balances) ? answer.balances : [];

  const read = rows.map((row) => {
    const money = row.balance_amount || row.amount || {};
    const value = Math.round(Number(money.amount != null ? money.amount : money) * 100);
    const type = String(row.balance_type || row.name || "OTHR").toUpperCase();
    return Number.isFinite(value)
      ? {
          type,
          amount: value,
          currency: String(money.currency || "PLN"),
          at: String(row.reference_date || row.last_change_date_time || "").slice(0, 10),
        }
      : null;
  }).filter(Boolean);

  if (read.length === 0) return null;

  read.sort((a, b) => {
    const rank = (row) => {
      const at = BALANCE_ORDER.findIndex((code) => row.type.includes(code));
      return at === -1 ? BALANCE_ORDER.length : at;
    };
    return rank(a) - rank(b);
  });

  return read[0];
}
