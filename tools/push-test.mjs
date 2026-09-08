/*
  The push crypto is the one part of Remembre that fails silently: get a key
  derivation wrong and the push service accepts the request, the device throws
  the record away, and nothing tells anybody. So this test plays the device.

  It generates a subscription keypair, encrypts a payload with the sender in
  api/_push.js, then decrypts it the way RFC 8291 says a browser does --
  reading the salt and sender key back out of the header, deriving the same
  secret from the other side of the exchange, and unwrapping the record. If any
  of the info strings, lengths or the record framing were wrong, the tag check
  fails and this test fails with it.

  Run: node tools/push-test.mjs
*/

import { createPublicKey, randomBytes, verify as verifyWith } from "node:crypto";
import { decrypt, makeDevice } from "./_push-receiver.mjs";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (text) => Buffer.from(String(text), "base64url");

const { encryptPayload, vapidHeader, generateVapidKeys, subscriptionId } =
  await import("../api/_push.js");

let passed = 0;
const failures = [];
const check = (label, ok, detail = "") => {
  if (ok) passed += 1;
  else failures.push(detail ? `${label} -- ${detail}` : label);
  console.log(`  ${ok ? "ok " : "NO "} ${label}`);
};

/* ---------- Encrypting ---------- */

console.log("\nencrypting a payload the device can read");

{
  const device = makeDevice();
  const message = JSON.stringify({ title: "Remember", body: "Economics practice paper due tomorrow" });
  const body = encryptPayload(message, device.subscription);

  check("the body starts with a 16-byte salt and a 65-byte sender key", body.readUInt8(20) === 65);
  check("the record size is announced", body.readUInt32BE(16) === 4096);
  check("the payload is not sitting in the clear", !body.toString("latin1").includes("Economics"));

  const opened = decrypt(device, body);
  check("the device recovers exactly what was sent", opened.text === message, opened.text);
  check("and sees the last-record delimiter", opened.delimiter === 2, String(opened.delimiter));
}

{
  // Two sends of the same text must not produce the same bytes, or the salt
  // and ephemeral key are not being regenerated.
  const device = makeDevice();
  const a = encryptPayload("same", device.subscription);
  const b = encryptPayload("same", device.subscription);
  check("every send gets a fresh salt and key", !a.equals(b));
  check("and both still decrypt", decrypt(device, a).text === "same" && decrypt(device, b).text === "same");
}

{
  const device = makeDevice();
  const other = makeDevice();
  const body = encryptPayload("for one device only", device.subscription);
  let refused = false;
  try {
    decrypt(other, body);
  } catch (err) {
    refused = true;
  }
  check("another device cannot open it", refused);
}

{
  const device = makeDevice();
  const long = "x".repeat(3000);
  check("a long payload survives", decrypt(device, encryptPayload(long, device.subscription)).text === long);
  const accented = "Wypracowanie z polskiego – rozdział 7";
  check("and so does non-ASCII text", decrypt(device, encryptPayload(accented, device.subscription)).text === accented);
}

{
  const device = makeDevice();
  let refused = 0;
  for (const broken of [{ ...device.subscription, auth: b64u(randomBytes(8)) }, { ...device.subscription, p256dh: b64u(randomBytes(20)) }]) {
    try { encryptPayload("x", broken); } catch (err) { refused += 1; }
  }
  check("a malformed subscription is refused rather than sent", refused === 2, String(refused));
}

/* ---------- Proving who is asking ---------- */

console.log("\nthe VAPID header");

{
  const keys = generateVapidKeys();
  check("a generated public key is a raw P-256 point", unb64u(keys.publicKey).length === 65 && unb64u(keys.publicKey)[0] === 4);

  process.env.VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.VAPID_PRIVATE_KEY = keys.privateKey;
  process.env.VAPID_SUBJECT = "mailto:someone@example.com";

  const { vapidKeys } = await import("../api/_push.js");
  const header = vapidHeader("https://web.push.apple.com/some/device/path", vapidKeys());

  const [, token] = header.match(/t=([^,]+)/);
  const [, key] = header.match(/k=(.+)$/);
  const [encodedHeader, encodedClaims, signature] = token.split(".");
  const claims = JSON.parse(unb64u(encodedClaims).toString("utf8"));

  check("it names the push service, not the whole endpoint", claims.aud === "https://web.push.apple.com", claims.aud);
  check("it carries the contact address", claims.sub === "mailto:someone@example.com");
  check("it expires, and within a day", claims.exp > Date.now() / 1000 && claims.exp < Date.now() / 1000 + 86400);
  check("it advertises the public key", key === keys.publicKey);
  check("it says ES256", JSON.parse(unb64u(encodedHeader).toString("utf8")).alg === "ES256");

  // The push service verifies this signature; so does this test, the same way.
  const point = unb64u(keys.publicKey);
  const publicKey = createPublicKey({
    format: "jwk",
    key: { kty: "EC", crv: "P-256", x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33, 65)) },
  });
  check(
    "and the signature verifies against it",
    verifyWith("sha256", Buffer.from(`${encodedHeader}.${encodedClaims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, unb64u(signature)),
  );
  check(
    "a tampered claim does not verify",
    !verifyWith("sha256", Buffer.from(`${encodedHeader}.${encodedClaims}x`), { key: publicKey, dsaEncoding: "ieee-p1363" }, unb64u(signature)),
  );
}

/* ---------- Keys that were set wrong ---------- */

console.log("\nkeys that were set wrong");

{
  /*
    Both values are opaque strings and the public one is served to the app, so
    pasting them the wrong way round publishes the private key AND breaks
    subscription, with nothing on either side saying why. Every one of these
    has to be caught before anything is served.
  */
  const { vapidReport } = await import("../api/_push.js");
  const good = generateVapidKeys();

  const withEnv = (publicKey, privateKey) => {
    if (publicKey === null) delete process.env.VAPID_PUBLIC_KEY;
    else process.env.VAPID_PUBLIC_KEY = publicKey;
    if (privateKey === null) delete process.env.VAPID_PRIVATE_KEY;
    else process.env.VAPID_PRIVATE_KEY = privateKey;
    return vapidReport();
  };

  const ok = withEnv(good.publicKey, good.privateKey);
  check("a real pair is accepted", ok.configured === true, ok.problem);
  check("and the public key is served", ok.publicKey === good.publicKey);

  const swapped = withEnv(good.privateKey, good.publicKey);
  check("the two the wrong way round is caught", swapped.configured === false);
  check("and named as exactly that", /wrong way round/.test(swapped.problem), swapped.problem);
  check("and the private key is not served anyway", swapped.publicKey === "", swapped.publicKey);
  check(
    "and it says to replace the pair, not just swap it",
    /fresh one/.test(swapped.problem),
    swapped.problem,
  );

  const other = generateVapidKeys();
  const mismatched = withEnv(good.publicKey, other.privateKey);
  check("two halves of different pairs are caught", mismatched.configured === false);
  check("and named", /not a pair/.test(mismatched.problem), mismatched.problem);

  const rubbish = withEnv("not-a-key", good.privateKey);
  check("a public key that is not one is caught", rubbish.configured === false && rubbish.publicKey === "");

  const missing = withEnv(good.publicKey, null);
  check("a half-set pair is caught", missing.configured === false);
  check("and never serves the half it has", missing.publicKey === "");

  // Nothing may be sent while any of that is true.
  const { vapidKeys: keysNow } = await import("../api/_push.js");
  withEnv(good.privateKey, good.publicKey);
  check("and nothing can be sent meanwhile", keysNow() === null);

  withEnv(good.publicKey, good.privateKey);
  check("once corrected, sending works again", keysNow() !== null);
}

/* ---------- Identifying a device ---------- */

{
  const a = subscriptionId("https://web.push.apple.com/one");
  check("a device id is derived from its endpoint", /^[a-f0-9]{32}$/.test(a));
  check("the same endpoint is the same device", a === subscriptionId("https://web.push.apple.com/one"));
  check("a different endpoint is a different device", a !== subscriptionId("https://web.push.apple.com/two"));
  check("and the endpoint is not readable from it", !a.includes("apple"));
}

if (failures.length) {
  console.error(`\n${failures.length} failed:\n` + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log(`\npush-test: ${passed}/${passed} checks passed`);
