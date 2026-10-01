/*
  The API key, before it is ever used.

  Every way it can be wrong produces the same 401 later, long after the paste
  that caused it, so each one is named here instead: an Admin key copied from
  the wrong Console page, a key with quotes round it, a truncated one, the bank
  key in the wrong slot. None of these checks spends anything or needs a
  network.

  Run: node tools/ai-test.mjs
*/

let passed = 0;
const failures = [];
const check = (label, ok, detail = "") => {
  if (ok) passed += 1;
  else failures.push(detail ? `${label} -- ${detail}` : label);
  console.log(`  ${ok ? "ok " : "NO "} ${label}`);
};

const set = (value) => {
  if (value === null) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = value;
};

const { aiReport, aiClient, MODEL } = await import("../api/_ai.js");

/* A key-shaped string that is not a key. */
const LOOKS_RIGHT = `sk-ant-api03-${"x".repeat(80)}`;

console.log("\nkeys that are not right");

{
  set(null);
  check("a missing key is named", /is not set/.test(aiReport().problem), aiReport().problem);

  set("hello");
  const wrong = aiReport();
  check("something that is not a key is caught", wrong.configured === false);
  check("and says what a key looks like", /begin sk-ant-/.test(wrong.problem), wrong.problem);
  check("with the shape of what arrived", wrong.sawInstead.length === 5, JSON.stringify(wrong.sawInstead));
  check("and not a character of it", !JSON.stringify(wrong).includes("hello"), JSON.stringify(wrong));

  // Both live on the Console and look alike; only one can call the Messages API.
  set(`sk-ant-admin01-${"x".repeat(80)}`);
  check("an Admin key is caught before it is used",
    /Admin API key/.test(aiReport().problem), aiReport().problem);

  set("sk-ant-api03-short");
  check("a truncated key is caught", /truncated/.test(aiReport().problem), aiReport().problem);

  // The other secrets in the same settings page, pasted into the wrong box.
  set("-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----");
  check("the bank's PEM in this slot is caught", aiReport().configured === false);
  check("and its shape says so", aiReport().sawInstead.looksLikePem, JSON.stringify(aiReport().sawInstead));

  set("cf589be3-3755-465b-a8df-a90a16a31403");
  check("an application id in this slot is caught", aiReport().sawInstead.looksLikeUuid);
}

console.log("\na key that is right");

{
  set(LOOKS_RIGHT);
  const good = aiReport();
  check("a well-formed key is accepted", good.configured === true, good.problem);
  check("and names the model it will use", good.model === MODEL, good.model);
  check("which is the current Opus", MODEL === "claude-opus-5-5", MODEL);
  check("the report never carries the key", !JSON.stringify(good).includes("xxxx"), JSON.stringify(good));

  // Quotes and padding come free with a copy, and should not cost an evening.
  set(`  "${LOOKS_RIGHT}"  `);
  check("quotes and spaces round it are forgiven", aiReport().configured === true, aiReport().problem);

  set(LOOKS_RIGHT);
  const client = aiClient();
  check("a client can be built", Boolean(client));
  // Reaching into the SDK's own options is brittle on purpose: if an upgrade
  // moves them, this fails loudly rather than quietly stopping checking.
  check("with a timeout well inside the platform's", client._options.timeout === 60000, String(client._options.timeout));
  check("and retries", client._options.maxRetries === 2, String(client._options.maxRetries));

  set("nonsense");
  check("and no client is built from a bad key", aiClient() === null);
}

console.log("\nnothing is spent to find out");

{
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../api/_ai.js", import.meta.url), "utf8")
    + fs.readFileSync(new URL("../api/advise.js", import.meta.url), "utf8"));

  // countTokens authenticates exactly like a real request and is not billed.
  check("the check counts tokens rather than generating any",
    /countTokens/.test(source) && !/messages\.create/.test(source));
}

if (failures.length) {
  console.error(`\n${failures.length} failed:\n` + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log(`\nai-test: ${passed}/${passed} checks passed`);
