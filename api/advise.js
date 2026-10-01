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

/*
  The shape of the answer, declared rather than asked for.

  Asking a chat model for "JSON and nothing else" works until it does not, and
  the two ways round that -- prefilling an opening brace, or stripping prose
  off the front -- are both a guess. A tool the model must call is not: the
  fields below are the schema it answers against, so there is no parsing step
  that can fail at the one moment somebody is looking at the page.
*/
const SHAPES = {
  analyse: {
    type: "object",
    properties: {
      headline: { type: "string", description: "One sentence: the single most useful thing in the data." },
      verdict: {
        type: "string",
        enum: ["sustainable", "tight", "overspending", "unclear"],
        description: "The rate of spending against money coming in. 'unclear' when there is less than three weeks of data or no income in it.",
      },
      reading: { type: "string", description: "Two or three short paragraphs of analysis, separated by blank lines. Plain text, at most 220 words." },
      notes: {
        type: "array",
        maxItems: 5,
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "Short name of the finding." },
            detail: { type: "string", description: "One sentence, with the number in it." },
          },
          required: ["label", "detail"],
        },
      },
      watch: {
        type: "array",
        maxItems: 3,
        items: { type: "string", description: "Something to keep an eye on, under ten words." },
      },
    },
    required: ["headline", "verdict", "reading", "notes", "watch"],
  },

  plan: {
    type: "object",
    properties: {
      approach: { type: "string", description: "Which framework you leaned on and why, one sentence." },
      monthly: {
        type: "array",
        items: {
          type: "object",
          properties: {
            category: { type: "string", description: "Exactly as spelled in the summary. Never a category that is not in it." },
            limit: { type: "number", description: "The monthly limit in whole zloty." },
            was: { type: "number", description: "What they actually spent on it in the month given, in whole zloty." },
            why: { type: "string", description: "One short sentence." },
          },
          required: ["category", "limit", "was", "why"],
        },
      },
      save: {
        type: "object",
        properties: {
          amount: { type: "number", description: "Whole zloty to put aside each month." },
          why: { type: "string" },
        },
        required: ["amount", "why"],
      },
      tradeoffs: {
        type: "array",
        maxItems: 3,
        items: { type: "string", description: "What a tightening costs in practice." },
      },
      year: { type: "string", description: "What this adds up to over twelve months if kept, one sentence." },
    },
    required: ["approach", "monthly", "save", "tradeoffs", "year"],
  },
};

/** One call to Claude, answered through the tool so the shape is guaranteed. */
async function ask(action, digest) {
  const client = aiClient();
  const system = action === "plan" ? PLAN_SYSTEM : ANALYSIS_SYSTEM;

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: action === "plan" ? 2000 : 1600,
    system,
    messages: [
      { role: "user", content: `Here is the summary of my spending.\n\n${JSON.stringify(digest, null, 1)}` },
    ],
    tools: [{
      name: "report",
      description: action === "plan"
        ? "Report the budget you propose. Always answer by calling this."
        : "Report what you read in the spending. Always answer by calling this.",
      input_schema: SHAPES[action],
    }],
    // No tool_choice: the current Opus supports neither "tool" nor "any", so
    // the tool is offered and the prompt asks for it. The fallback below is
    // what makes that safe rather than hopeful.
  });

  const usage = message.usage || {};
  const cost = { in: usage.input_tokens || 0, out: usage.output_tokens || 0 };

  const reported = message.content.find((block) => block.type === "tool_use");
  if (reported) return { result: reported.input, cost };

  // It answered in prose. If the prose is the shape anyway -- a fenced block,
  // or an object with something polite in front of it -- take it; otherwise
  // show what it said rather than erroring over it.
  const prose = message.content.filter((block) => block.type === "text")
    .map((block) => block.text).join("").trim();

  const found = objectIn(prose);
  if (found) return { result: found, cost };
  return { result: null, prose, cost };
}

/** The first balanced {...} in a piece of text, parsed, or null. */
function objectIn(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let quoted = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1));
          return parsed && typeof parsed === "object" ? parsed : null;
        } catch (err) {
          return null;
        }
      }
    }
  }
  return null;
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
