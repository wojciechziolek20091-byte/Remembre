import { cors, json, store, storeReport } from "./_store.js";
import { vapidReport } from "./_push.js";
import { bankReport } from "./_bank.js";
import { aiReport } from "./_ai.js";

/**
 * A deployment can be missing its storage entirely, and the app needs to be
 * able to say so in plain words instead of failing at the first sync. This
 * reports which store is live and, when none is, exactly which environment
 * variables would make one live. It never reports a value.
 */
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "GET") return json(res, 405, { error: "method-not-allowed" });

  /*
    ?check=store actually uses the store rather than reporting on its
    configuration: it writes a scratch key, reads it back, empties it and
    checks it is gone. All four steps on a key of its own, nothing else
    touched.

    This exists because the configuration looked perfect for weeks while a
    write the bank callback depended on answered 400 every time. "The
    variables are set" and "the store works" are different claims, and only
    one of them was being made.
  */
  if (new URL(req.url, "http://localhost").searchParams.get("check") === "store") {
    return json(res, 200, await exerciseStore());
  }

  // The app needs the public half of the notification key to subscribe a
  // device, so it is served here. It is public by design -- but only once it
  // has been checked, because a mis-set variable would otherwise publish the
  // private half instead, which is the one mistake that must not go quietly.
  const push = vapidReport();

  return json(res, 200, {
    ok: true,
    ...storeReport(),
    push: { needs: "VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY", ...push },
    bank: { needs: "ENABLE_BANKING_APP_ID and ENABLE_BANKING_PRIVATE_KEY", ...bankReport() },
    ai: { needs: "ANTHROPIC_API_KEY", ...aiReport() },
  });
}

/** Write, read, empty, confirm gone. Says which step failed, if one does. */
async function exerciseStore() {
  const live = store();
  if (!live) return { ok: false, step: "attach", message: "No store is configured." };

  const key = `selftest_${Date.now().toString(36)}`;
  const written = JSON.stringify({ at: new Date().toISOString() });
  const steps = [];

  try {
    await live.put(key, written);
    steps.push("write");

    const read = await live.get(key);
    if (read !== written) {
      return { ok: false, step: "read", using: live.name, message: "What came back was not what went in." };
    }
    steps.push("read");

    // The step that was broken: emptying a key must not send a malformed
    // command, whichever way the caller asks for it.
    await live.put(key, "");
    steps.push("empty");

    const gone = await live.get(key);
    if (gone !== null) {
      return { ok: false, step: "gone", using: live.name, message: "Emptying it left something behind." };
    }
    steps.push("gone");

    return { ok: true, using: live.name, label: live.label, steps };
  } catch (err) {
    return {
      ok: false,
      using: live.name,
      step: steps.length ? `after ${steps[steps.length - 1]}` : "write",
      message: String(err && err.message).slice(0, 200),
    };
  }
}
