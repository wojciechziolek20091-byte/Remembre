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

    /*
      On the free plan the API only ever returns accounts that were linked by
      hand in the Control Panel, so "the credentials work" and "there is
      anything to read" are different questions. This asks the second one too,
      because the difference between them is a step the reader has to take and
      would otherwise only discover when a fetch came back empty.
    */
    let application = null;
    try {
      application = await bankFetch("/application");
    } catch (err) {
      application = { unavailable: err.message };
    }

    return json(res, 200, {
      ok: true,
      configured: true,
      reached: true,
      polishBanks: banks.length,
      // Enough to see mBank is there without returning the whole catalogue.
      mbank: banks.some((bank) => /mbank/i.test(bank.name || "")),
      application: describeApplication(application),
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

/**
 * What the Control Panel says about this application, reduced to the parts
 * that answer "is there anything left to do". No ids, no URLs, no secrets.
 */
function describeApplication(application) {
  if (!application || application.unavailable) {
    return { readable: false, why: (application && application.unavailable) || "no answer" };
  }

  // The shape of this response is theirs to change, so look for the facts
  // rather than insisting on a particular field.
  const accounts = Array.isArray(application.accounts) ? application.accounts
    : Array.isArray(application.linked_accounts) ? application.linked_accounts
    : null;

  return {
    readable: true,
    name: String(application.name || ""),
    active: application.active !== false,
    environment: String(application.environment || ""),
    // "Restricted" is the free plan, and is expected rather than a problem.
    restricted: /restricted/i.test(JSON.stringify(application)),
    linkedAccounts: accounts ? accounts.length : null,
    keys: Object.keys(application).sort(),
  };
}
