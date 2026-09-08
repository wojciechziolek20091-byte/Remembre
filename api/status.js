import { cors, json, storeReport } from "./_store.js";
import { vapidReport } from "./_push.js";

/**
 * A deployment can be missing its storage entirely, and the app needs to be
 * able to say so in plain words instead of failing at the first sync. This
 * reports which store is live and, when none is, exactly which environment
 * variables would make one live. It never reports a value.
 */
export default function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "GET") return json(res, 405, { error: "method-not-allowed" });

  // The app needs the public half of the notification key to subscribe a
  // device, so it is served here. It is public by design -- but only once it
  // has been checked, because a mis-set variable would otherwise publish the
  // private half instead, which is the one mistake that must not go quietly.
  const push = vapidReport();

  json(res, 200, {
    ok: true,
    ...storeReport(),
    push: { needs: "VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY", ...push },
  });
}
