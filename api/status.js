import { cors, json, storeReport } from "./_store.js";
import { vapidKeys } from "./_push.js";

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
  // device, so it is served here. It is public by design; the private half is
  // never sent anywhere.
  const keys = vapidKeys();

  json(res, 200, {
    ok: true,
    ...storeReport(),
    push: {
      configured: Boolean(keys),
      needs: "VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY",
      publicKey: keys ? keys.publicKey : "",
    },
  });
}
