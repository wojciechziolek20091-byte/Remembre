/*
  The credential layer, without a network in sight.

  The signature matters most: a JWT Enable Banking rejects produces a 401 with
  nothing in it to say why, so this builds one and verifies it against the
  public half of the same key, the way their API will. The rest is about naming
  a misconfiguration precisely -- a key of the wrong kind, a key with its line
  breaks eaten by a settings box -- because every one of those otherwise
  surfaces as the same unhelpful 401 weeks later.

  Run: node tools/bank-test.mjs
*/

import { generateKeyPairSync, verify as verifyWith } from "node:crypto";

const KEYS = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = KEYS.privateKey.export({ type: "pkcs8", format: "pem" });
const APP_ID = "cf589be3-3755-465b-a8df-a90a16a31403";

let passed = 0;
const failures = [];
const check = (label, ok, detail = "") => {
  if (ok) passed += 1;
  else failures.push(detail ? `${label} -- ${detail}` : label);
  console.log(`  ${ok ? "ok " : "NO "} ${label}`);
};

const set = (appId, key) => {
  if (appId === null) delete process.env.ENABLE_BANKING_APP_ID;
  else process.env.ENABLE_BANKING_APP_ID = appId;
  if (key === null) delete process.env.ENABLE_BANKING_PRIVATE_KEY;
  else process.env.ENABLE_BANKING_PRIVATE_KEY = key;
};

const { bankReport, bankCredentials } = await import("../api/_bank.js");

/* ---------- Credentials that are wrong ---------- */

console.log("\ncredentials that are not right");

{
  set(null, null);
  check("neither set is named as such", /are not set/.test(bankReport().problem), bankReport().problem);

  set(APP_ID, null);
  check("a missing key is named", /PRIVATE_KEY is not set/.test(bankReport().problem), bankReport().problem);

  set(null, PEM);
  check("a missing id is named", /APP_ID is not set/.test(bankReport().problem), bankReport().problem);

  set("not-an-id", PEM);
  check("an id that is not one is caught", /does not look like an application id/.test(bankReport().problem));

  set(APP_ID, "just some text");
  const notAKey = bankReport();
  check("a key that is not a PEM is caught", /not a PEM private key/.test(notAKey.problem));
  check("and its shape is described, so it can be worked out",
    notAKey.sawInstead.length === 14 && notAKey.sawInstead.mentionsBegin === false,
    JSON.stringify(notAKey.sawInstead));
  check("without a character of it being reported",
    !JSON.stringify(notAKey).includes("just some"), JSON.stringify(notAKey));

  // The two most likely wrong pastes, named so they can be recognised.
  set(APP_ID, APP_ID);
  check("pasting the application id into the key slot is visible in the shape",
    bankReport().sawInstead.looksLikeUuid, JSON.stringify(bankReport().sawInstead));
  set(APP_ID, KEYS.publicKey.export({ type: "spki", format: "pem" }));
  check("pasting the public half is caught", bankReport().configured === false);
  check("and says it saw a public key",
    bankReport().sawInstead.mentionsPublic, JSON.stringify(bankReport().sawInstead));

  // The failure the settings box actually causes.
  set(APP_ID, PEM.replace(/\n/g, ""));
  const squashed = bankReport();
  check("a PEM with its line breaks eaten is repaired, not refused", squashed.configured === true, squashed.problem);

  set(APP_ID, PEM.replace(/\n/g, "\\n"));
  const escaped = bankReport();
  check("and so is one with literal backslash-n", escaped.configured === true, escaped.problem);

  // Armour lost entirely: the key is still there and still usable.
  const bare = PEM.replace(/-----[A-Z ]+-----/g, "").replace(/\s/g, "");
  set(APP_ID, bare);
  check("and so is a key with no header or footer at all", bankReport().configured === true, bankReport().problem);

  set(APP_ID, `"${PEM}"`);
  check("and one wrapped in quotes", bankReport().configured === true, bankReport().problem);

  // Easy to generate by accident; fails at the first call rather than here.
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  set(APP_ID, ec.privateKey.export({ type: "pkcs8", format: "pem" }));
  check("an EC key is caught before it is ever used", /signs with RSA/.test(bankReport().problem), bankReport().problem);

  set(APP_ID, PEM.slice(0, PEM.length / 2));
  check("a truncated key is caught", bankReport().configured === false);

  const everything = JSON.stringify([bankReport(), { ...bankReport() }]);
  check("no report ever carries the key itself", !everything.includes("PRIVATE KEY"));
}

/* ---------- Credentials that are right ---------- */

console.log("\na JWT their API will accept");

{
  set(APP_ID, PEM);
  const report = bankReport();
  check("a real pair is accepted", report.configured === true, report.problem);
  check("and reports the kind of key", report.keyType, "rsa");
  check("and its size", report.keyBits, 2048);

  const credentials = bankCredentials();
  check("the credentials come back", Boolean(credentials && credentials.appId === APP_ID));

  // Rebuild the token the way the module does, and check it the way they will.
  const token = await (async () => {
    const module = await import("../api/_bank.js?token-check");
    // bankToken is private, so exercise it through the only door it has: a
    // fetch, intercepted before it leaves.
    const realFetch = globalThis.fetch;
    let seen = "";
    globalThis.fetch = async (url, options) => {
      seen = options.headers.Authorization;
      return { ok: true, status: 200, text: async () => "{}" };
    };
    await module.bankFetch("/aspsps?country=PL");
    globalThis.fetch = realFetch;
    return seen.replace(/^Bearer /, "");
  })();

  const [header, claims, signature] = token.split(".");
  const read = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

  check("the header says RS256", read(header).alg, "RS256");
  check("and carries the application id as kid", read(header).kid, APP_ID);
  check("the issuer is theirs", read(claims).iss, "enablebanking.com");
  check("and the audience", read(claims).aud, "api.enablebanking.com");
  check("it expires", read(claims).exp > read(claims).iat, true);
  check("well inside their 24-hour ceiling", read(claims).exp - read(claims).iat <= 86400, true);

  const publicKey = KEYS.publicKey;
  check(
    "and the signature verifies against the public half",
    verifyWith("sha256", Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, "base64url")),
  );
  check(
    "a tampered claim does not verify",
    !verifyWith("sha256", Buffer.from(`${header}.${claims}x`), publicKey, Buffer.from(signature, "base64url")),
  );
}

/* ---------- Nothing here can move money ---------- */

console.log("\nread-only by construction");

{
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../api/_bank.js", import.meta.url), "utf8")
    + fs.readFileSync(new URL("../api/bank.js", import.meta.url), "utf8"));

  // A payment under PSD2 goes through a payment-initiation endpoint. If one
  // ever appears in these files it should be a deliberate decision, not a
  // quiet addition, so the test is here to make it loud.
  check("no payment endpoint is referenced", !/\/payments?\b/.test(source));
  check("no payment initiation", !/payment[- _]?initiation/i.test(source));
}

if (failures.length) {
  console.error(`\n${failures.length} failed:\n` + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log(`\nbank-test: ${passed}/${passed} checks passed`);
