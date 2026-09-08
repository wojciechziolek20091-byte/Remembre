/*
  The receiving half of RFC 8291, written from the specification so the tests
  can check the sender against something other than itself. This is what a
  browser does with the bytes a push service relays to it: read the salt and
  the sender's key out of the header, derive the same secret from the other
  side of the exchange, and unwrap the single record.
*/

import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (text) => Buffer.from(String(text), "base64url");

/** A device, with the keys a browser would have generated for a subscription. */
export function makeDevice(endpoint = "https://push.example/device") {
  const ecdh = createECDH("prime256v1");
  const p256dh = ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    ecdh,
    endpoint,
    p256dh: b64u(p256dh),
    auth: b64u(auth),
    subscription: { endpoint, p256dh: b64u(p256dh), auth: b64u(auth) },
    browserShape: { endpoint, keys: { p256dh: b64u(p256dh), auth: b64u(auth) } },
  };
}

export function decrypt(device, body) {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const idLength = body.readUInt8(20);
  const senderPublic = body.subarray(21, 21 + idLength);
  const record = body.subarray(21 + idLength);

  const shared = device.ecdh.computeSecret(senderPublic);
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0"), device.ecdh.getPublicKey(), senderPublic,
  ]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, unb64u(device.auth), keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));

  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const plaintext = Buffer.concat([
    decipher.update(record.subarray(0, record.length - 16)), decipher.final(),
  ]);

  return {
    text: plaintext.subarray(0, -1).toString("utf8"),
    delimiter: plaintext[plaintext.length - 1],
    recordSize,
  };
}
