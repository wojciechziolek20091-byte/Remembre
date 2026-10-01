import { cors, json } from "./_store.js";
import { bankFetch, bankReport } from "./_bank.js";

/**
 * Read-only bank access.
 *
 *   GET /api/bank?action=check   can this deployment talk to Enable Banking?
 *
 * "check" asks for the list of Polish banks, which is the smallest call that
 * proves the application id and the signature are both right. It returns a
 * count rather than the list: this is a yes-or-no, not a data route.
 */
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "GET") return json(res, 405, { error: "method-not-allowed" });

  const report = bankReport();
  if (!report.configured) {
    return json(res, 503, { ok: false, configured: false, problem: report.problem });
  }

  const action = new URL(req.url, "http://localhost").searchParams.get("action") || "check";
  if (action !== "check") {
    return json(res, 400, { error: "unknown-action", message: `There is no "${action}" yet.` });
  }

  try {
    const answer = await bankFetch("/aspsps?country=PL");
    const banks = Array.isArray(answer && answer.aspsps) ? answer.aspsps : [];
    return json(res, 200, {
      ok: true,
      configured: true,
      reached: true,
      polishBanks: banks.length,
      // Enough to see mBank is there without returning the whole catalogue.
      mbank: banks.some((bank) => /mbank/i.test(bank.name || "")),
    });
  } catch (err) {
    console.error("bank check failed:", err.status || "", err.message);
    return json(res, 502, {
      ok: false,
      configured: true,
      reached: false,
      status: err.status || 0,
      message: err.message,
    });
  }
}
