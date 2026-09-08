import { cors, json, storeReport } from "./_store.js";

/**
 * A deployment can be missing its storage entirely, and the app needs to be
 * able to say so in plain words instead of failing at the first sync. This
 * reports which store is live and, when none is, exactly which environment
 * variables would make one live. It never reports a value.
 */
export default function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "GET") return json(res, 405, { error: "method-not-allowed" });
  json(res, 200, { ok: true, ...storeReport() });
}
