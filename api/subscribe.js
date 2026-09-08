import { checkCode, cors, json, notConfigured, store, vaultKey } from "./_store.js";
import { forgetSubscription, saveSubscription, subscriptionId, vapidKeys } from "./_push.js";

/**
 * A device saying where to reach it.
 *
 *   POST   /api/subscribe   remember this device for this sync phrase
 *   DELETE /api/subscribe   forget it
 *
 * The subscription is filed against the vault key, not the phrase, so the
 * nightly run can look up what is due without ever holding the phrase itself.
 * The device also sends its time zone, because "the day before, at 17:00" is a
 * question about the device's clock and the server's is set to UTC.
 */
export default async function handler(req, res) {
  if (cors(req, res)) return;

  const live = store();
  if (!live) return notConfigured(res);
  if (!vapidKeys()) {
    return json(res, 503, {
      error: "no-keys",
      message:
        "This Remembre server has no notification keys yet, so it cannot send anything. " +
        "VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY need setting.",
    });
  }

  const body = await readBody(req);
  const problem = checkCode(body && body.code);
  if (problem) return json(res, 400, { error: "bad-code", message: problem });

  const subscription = body.subscription;
  const endpoint = subscription && typeof subscription.endpoint === "string" ? subscription.endpoint : "";
  if (!/^https:\/\//.test(endpoint)) {
    return json(res, 400, { error: "bad-subscription", message: "That is not a push subscription." });
  }

  const id = subscriptionId(endpoint);

  try {
    if (req.method === "DELETE") {
      await forgetSubscription(live, id);
      return json(res, 200, { ok: true, subscribed: false });
    }
    if (req.method !== "POST") return json(res, 405, { error: "method-not-allowed" });

    const keys = subscription.keys || {};
    if (!keys.p256dh || !keys.auth) {
      return json(res, 400, { error: "bad-subscription", message: "That subscription has no keys." });
    }

    await saveSubscription(live, id, {
      vault: vaultKey(body.code.trim()),
      endpoint,
      p256dh: String(keys.p256dh),
      auth: String(keys.auth),
      // An unknown zone is not a reason to refuse; UTC just means the reminder
      // lands at a time the reader can correct by re-subscribing.
      zone: typeof body.zone === "string" && body.zone ? body.zone.slice(0, 60) : "UTC",
      updatedAt: new Date().toISOString(),
      lastSentFor: "",
    });

    return json(res, 200, { ok: true, subscribed: true, device: id });
  } catch (err) {
    console.error("subscribe failed:", err);
    return json(res, 502, {
      error: "store-unavailable",
      message: "The store did not answer. Try turning reminders on again.",
    });
  }
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) return {};
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (err) {
    return {};
  }
}
