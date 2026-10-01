import { cors, json } from "./_store.js";
import { aiCheck, aiReport } from "./_ai.js";

/**
 * The analysis route.
 *
 *   GET /api/advise?action=check   is the key usable?
 *
 * Checking counts tokens rather than generating any, which authenticates the
 * same way a real request does and is not billed -- so it can be run as often
 * as it is useful without costing anything.
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
  if (action !== "check") {
    return json(res, 400, { error: "unknown-action", message: `There is no "${action}" yet.` });
  }

  try {
    const result = await aiCheck();
    return json(res, 200, { ok: true, configured: true, reached: true, ...result });
  } catch (err) {
    // The status is the useful part: 401 is a bad key, 402 is an empty
    // balance, 429 is a rate limit. They need different answers from the
    // reader, so they should not all read as "it did not work".
    const status = err && err.status ? err.status : 0;
    console.error("ai check failed:", status, err && err.message);
    return json(res, 502, {
      ok: false,
      configured: true,
      reached: false,
      status,
      message:
        status === 401 ? "The key was refused. Check it was copied whole."
        : status === 402 ? "The key works, but the account has no credit."
        : status === 429 ? "Rate limited. Try again in a moment."
        : (err && err.message) || "The request failed.",
    });
  }
}
