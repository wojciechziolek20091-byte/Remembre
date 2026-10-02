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
  check("with a timeout well inside the platform's", client._options.timeout === 50000, String(client._options.timeout));
  check("and one retry, which is all that fits in the budget",
    client._options.maxRetries === 1, String(client._options.maxRetries));

  set("nonsense");
  check("and no client is built from a bad key", aiClient() === null);
}

console.log("\nnothing is spent to find out");

const read = await import("node:fs").then((fs) => (name) =>
  fs.readFileSync(new URL(`../api/${name}`, import.meta.url), "utf8"));

{
  // countTokens authenticates exactly like a real request and is not billed,
  // so the check must use it and must never reach the generating endpoint.
  const ai = read("_ai.js");
  check("the check counts tokens rather than generating any",
    /countTokens/.test(ai) && !/messages\.create/.test(ai));

  const advise = read("advise.js");
  const checkBranch = advise.slice(advise.indexOf('action === "check"'), advise.indexOf('action !== "analyse"'));
  check("and the check route only ever calls that",
    /aiCheck\(\)/.test(checkBranch) && !/messages\.create/.test(checkBranch));

  // Generating is reached by exactly one path, and that path has an action.
  check("generating happens in one place only",
    (advise.match(/messages\.create/g) || []).length === 1);
  check("and only for the two actions that ask for it",
    /action !== "analyse" && action !== "plan"/.test(advise));
}

console.log("\nwhat is refused before a request is made");

const callAdvise = async (url, body) => {
  const { default: handler } = await import(`../api/advise.js?v=${Math.random()}`);
  const out = { status: 0, body: null };
  const res = {
    statusCode: 200,
    setHeader() {},
    end(text) { out.body = text ? JSON.parse(text) : null; out.status = res.statusCode; },
    writeHead(code) { res.statusCode = code; return res; },
  };
  const req = { method: body ? "POST" : "GET", url, headers: {}, body };
  await handler(req, res);
  return out;
};

{
  set(null);
  const noKey = await callAdvise("/api/advise?action=analyse", { digest: { days: 30, categories: [{}] } });
  check("with no key, nothing is attempted", noKey.status === 503, String(noKey.status));
  check("and it says why", /not set/.test((noKey.body && noKey.body.problem) || ""), JSON.stringify(noKey.body));

  set(LOOKS_RIGHT);
  const unknown = await callAdvise("/api/advise?action=rummage", { digest: {} });
  check("an action that does not exist is named", unknown.status === 400, String(unknown.status));

  const empty = await callAdvise("/api/advise?action=analyse", {});
  check("a request with nothing to analyse is refused", empty.status === 400, String(empty.status));

  // A week is the floor: less than that and the advice would be confident
  // nonsense, so it is refused here rather than dressed up.
  const thin = await callAdvise("/api/advise?action=analyse", {
    digest: { days: 3, categories: [{ name: "food", thisMonth: 12 }] },
  });
  check("so is less than a week of data", thin.status === 200 && thin.body.thin === true, JSON.stringify(thin.body));
  check("and it says what would fix it", /Import a bit more/.test(thin.body.message), thin.body.message);

  const noCategories = await callAdvise("/api/advise?action=plan", { digest: { days: 40, categories: [] } });
  check("and a month with no categories in it", noCategories.body.thin === true, JSON.stringify(noCategories.body));
}

console.log("\nthe Sunday debrief");

{
  const debrief = read("debrief.js");
  const playbook = read("_playbook.js");

  // It is its own route because it calls Claude, which takes tens of seconds,
  // and the reminder run is called every quarter of an hour.
  check("it is allowed the time the model takes", /export const maxDuration = 60/.test(debrief));
  check("and generating happens in one place", (debrief.match(/messages\.create/g) || []).length === 1);
  check("the answer's shape is the tool's", /input_schema: SHAPE/.test(debrief));
  check("a half-answer is refused rather than stored",
    /SHAPE\.required\.every/.test(debrief) && /came back as prose/.test(debrief));

  // Only on a Sunday evening where the reader is, and never twice.
  check("it is gated on the reader's own Sunday",
    /getUTCDay\(\) === 0/.test(debrief) && /clock\.hour < EVENING/.test(debrief));
  check("and never writes the same week twice",
    /weeks\.some\(\(one\) => one\.week === week\)/.test(debrief));
  check("a run with no secret writes nothing",
    /dryRun: true, message: "No secret/.test(debrief));
  // Without force the worst a knock can cost is one reading per vault per
  // week; with it, one per knock. So force needs the secret.
  check("and forcing one needs the secret",
    /const force = asked && Boolean\(secret\) && offered === secret/.test(debrief));
  check("the week's Sunday is the week's, not the day it was written",
    /sunday: weekEnd/.test(debrief) && /writtenOn: sunday/.test(debrief));

  check("the prompt knows the week has two halves",
    /Weekdays are Monday to Thursday/.test(playbook) && /weekend is Friday to Sunday/.test(playbook));
  check("and that finding a problem every week is how it gets ignored",
    /gets ignored/.test(playbook) && /Nothing needs curbing/.test(playbook));
  check("the headline is written for a lock screen",
    /readable on a lock screen/.test(playbook));
}

console.log("\nan answer that arrives the wrong way round");

{
  // Pulled out of the module and exercised directly: it is the one piece of
  // the path that runs when the model does not do as it is asked.
  const advise = read("advise.js");
  const body = advise.slice(advise.indexOf("function objectIn"));
  const objectIn = eval(`(${body.slice(0, body.indexOf("\n}\n") + 3).replace("function objectIn", "function")})`);

  const fenced = objectIn('Here you go:\n```json\n{"verdict":"tight"}\n```');
  check("a fenced block is read", fenced !== null && fenced.verdict === "tight", JSON.stringify(fenced));
  check("a brace inside a string does not end it",
    objectIn('{"s":"a } brace"}').s === "a } brace");
  check("an escaped quote does not either",
    objectIn('{"s":"a \\" quote"}').s === 'a " quote');
  check("a truncated answer is not half-read", objectIn('{"a":') === null);
  check("and prose with no object in it is left as prose", objectIn("no object here") === null);
}

console.log("\nwhat the model is told before it sees a number");

{
  const playbook = read("_playbook.js");
  check("the frameworks are named, not invented",
    /50\/30\/20/.test(playbook) && /zero-based|Zero-based/.test(playbook)
    && /[Ss]inking funds/.test(playbook) && /Pay yourself first/.test(playbook));
  check("the Polish figures carry their source",
    /Portfel Studenta 2026/.test(playbook) && /wib\.org\.pl/.test(playbook));
  check("every rule of thumb has somewhere it came from",
    (playbook.match(/https:\/\//g) || []).length >= 5);
  check("the answer is pinned to a shape",
    /"verdict"/.test(playbook) && /"monthly"/.test(playbook));
  // A shape asked for in prose is a hope; a tool it must call is not.
  const advise = read("advise.js");
  check("and the shape is the tool's, not a hope about JSON",
    /name: "report"/.test(advise) && /input_schema: SHAPES\[action\]/.test(advise));
  // A tool call that ran out of room arrives as a headline with nothing under
  // it, which reads as a finished answer rather than a failed one.
  check("an answer missing its required fields is refused, not shown",
    /REQUIRED\[action\]/.test(advise) && /ran long and was cut off/.test(advise));
  check("a prose answer is still shown rather than erroring over",
    /result: null, prose/.test(advise));
  // The model is asked for the tool rather than forced into it, because the
  // current Opus supports neither "tool" nor "any" as a tool_choice.
  check("the tool is offered, not forced", !/tool_choice:\s*\{/.test(advise));
  check("and prose that is the shape anyway is taken", /objectIn\(prose\)/.test(advise));
  // Both were refused outright by the current Opus, and the 400 reads as
  // "the analysis is broken" to anyone who only sees the page.
  // Ten seconds is the default on this platform and Opus needs more; a run
  // killed halfway answers nothing at all, which reads as a broken page.
  check("the function is allowed to take as long as the model does",
    /export const maxDuration = 60/.test(advise));
  check("nothing the current model refuses is sent",
    !/temperature:/.test(advise) && !/role: "assistant"/.test(advise));
  check("and it is told not to invent transactions",
    /[Dd]o not invent/.test(playbook));
  // The reader is seventeen and lives at home. Pension advice is noise.
  // A set of limits that spends everything that arrives is not a budget.
  check("the saving has a floor the limits may not eat",
    /must not come to more\s+than 80% of the income plan/.test(playbook.replace(/\s+/g, " ")));
  check("and who it is writing for",
    /secondary-school student/.test(playbook) && /pension/.test(playbook));
}

if (failures.length) {
  console.error(`\n${failures.length} failed:\n` + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log(`\nai-test: ${passed}/${passed} checks passed`);
