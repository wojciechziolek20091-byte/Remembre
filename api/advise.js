import { cors, json } from "./_store.js";
import { aiCheck, aiClient, aiReport, MODEL } from "./_ai.js";
import { ANALYSIS_SYSTEM, PLAN_SYSTEM } from "./_playbook.js";

/**
 * The analysis route.
 *
 *   GET  /api/advise?action=check     is the key usable?
 *   POST /api/advise?action=analyse   read this spending and say what it means
 *   POST /api/advise?action=plan      propose budgets from this spending
 *
 * Checking counts tokens rather than generating any, which authenticates the
 * same way a real request does and is not billed -- so it can be run as often
 * as it is useful without costing anything.
 *
 * The two real actions take a *summary*, not a statement. The page has already
 * done the arithmetic; what goes over the wire is a few dozen totals and the
 * top handful of payees, which is a fraction of the tokens a transaction list
 * would be and tells the model everything it can actually use.
 */
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "GET" && req.method !== "POST") {
    return json(res, 405, { error: "method-not-allowed" });
  }

  const report = aiReport();
  if (!report.configured) {
    return json(res, 503, { ok: false, configured: false, ...report });
  }

  const action = new URL(req.url, "http://localhost").searchParams.get("action") || "check";

  if (action === "check") {
    try {
      const result = await aiCheck();
      return json(res, 200, { ok: true, configured: true, reached: true, ...result });
    } catch (err) {
      return json(res, 502, { ok: false, configured: true, reached: false, ...describe(err) });
    }
  }

  if (action !== "analyse" && action !== "plan") {
    return json(res, 400, { error: "unknown-action", message: `There is no "${action}".` });
  }

  const body = await readBody(req);
  const digest = body && body.digest;
  if (!digest || typeof digest !== "object") {
    return json(res, 400, { error: "no-digest", message: "Nothing was sent to analyse." });
  }

  // Thin data produces confident nonsense, so it is refused here rather than
  // dressed up: the page says what is missing instead.
  if (!Number.isFinite(digest.days) || digest.days < 7 || !Array.isArray(digest.categories) || digest.categories.length === 0) {
    return json(res, 200, {
      ok: true,
      thin: true,
      message: "There is less than a week of spending here. Import a bit more and this will be worth reading.",
    });
  }

  try {
    const answer = await ask(action, digest);
    return json(res, 200, { ok: true, action, model: MODEL, ...answer });
  } catch (err) {
    console.error(`ai ${action} failed:`, err.status || "", err.message);
    return json(res, 502, { ok: false, action, ...describe(err) });
  }
}

/**
 * One call to Claude, with the answer parsed.
 *
 * The model is asked for JSON and nothing else, and the request is prefilled
 * with an opening brace so there is no prose to strip -- the one reliable way
 * to get JSON out of a chat model. Even so the parse is defended: a reply that
 * cannot be read comes back as prose rather than as an error, because an
 * analysis is still worth reading when it has lost its shape.
 */
async function ask(action, digest) {
  const client = aiClient();
  const system = action === "plan" ? PLAN_SYSTEM : ANALYSIS_SYSTEM;

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: action === "plan" ? 1600 : 1200,
    system,
    temperature: 0.2,
    messages: [
      { role: "user", content: `Here is the summary of my spending.\n\n${JSON.stringify(digest, null, 1)}` },
      { role: "assistant", content: "{" },
    ],
  });

  const text = "{" + message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  const usage = message.usage || {};
  const cost = {
    in: usage.input_tokens || 0,
    out: usage.output_tokens || 0,
  };

  try {
    return { result: JSON.parse(text), cost };
  } catch (err) {
    return { result: null, prose: text.replace(/^\{/, "").trim(), cost };
  }
}

/* The status is the useful part: 401 is a bad key, 402 an empty balance, 429 a
   rate limit. They need different answers from the reader. */
function describe(err) {
  const status = err && err.status ? err.status : 0;
  return {
    status,
    message:
      status === 401 ? "The key was refused. Check it was copied whole."
      : status === 402 ? "The key works, but the account has no credit left."
      : status === 429 ? "Rate limited. Try again in a moment."
      : status === 529 ? "Claude is busy. Try again in a moment."
      : (err && err.message) || "The request failed.",
  };
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    // A digest is a few kilobytes. Anything much larger is not one.
    if (size > 256 * 1024) return null;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (err) {
    return null;
  }
}
