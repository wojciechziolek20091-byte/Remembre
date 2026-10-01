import { store } from "./_store.js";
import { bankSession } from "./_bank.js";
import { handoverKey, loadConnection, noteOutcome, readJson, saveConnection } from "./_bankstore.js";

/**
 * Where the bank sends the reader back to.
 *
 * It arrives as a plain browser navigation, so it answers with a redirect into
 * the app rather than with JSON, and carries the outcome in the address: there
 * is a person looking at this, not a script.
 *
 * The "state" is a one-time nonce, not the vault key. It travels through the
 * bank and lands in logs on the way, and a nonce there says nothing about
 * whose account this is.
 */
export default async function handler(req, res) {
  const url = new URL(req.url, "https://localhost");
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const refused = url.searchParams.get("error") || "";

  const live = store();

  /*
    Every way out of here is recorded before the redirect. A reader who comes
    back to a page that looks unchanged has no way of telling which of the six
    things went wrong, and neither had anybody else.
  */
  const home = async (outcome, detail = "") => {
    if (live) await noteOutcome(live, outcome, detail);
    res.statusCode = 302;
    res.setHeader("Location", `/?bank=${encodeURIComponent(outcome)}`);
    res.setHeader("Cache-Control", "no-store");
    res.end();
  };

  if (refused) return home("refused", `the bank sent back error=${String(refused).slice(0, 60)}`);
  if (!code || !/^[a-f0-9]{16,}$/i.test(state)) {
    return home("bad-return", `code ${code ? "present" : "missing"}, state ${state ? "malformed" : "missing"}`);
  }
  if (!live) {
    res.statusCode = 302;
    res.setHeader("Location", "/?bank=no-store");
    res.setHeader("Cache-Control", "no-store");
    return res.end();
  }

  try {
    const handover = await readJson(live, handoverKey(state), null);
    // The nonce is good once. A replayed return should not attach somebody
    // else's bank session to a vault. Deleted rather than blanked: a store
    // asked to write nothing is a store asked to write a malformed command.
    await live.del(handoverKey(state));
    if (!handover || !handover.vault) {
      return home("expired", handover ? "the handover had no vault on it" : "no handover was stored under that state");
    }

    const session = await bankSession(code);
    if (session.accounts.length === 0) {
      return home("no-accounts", `the session came back with ${session.rawCount} account${session.rawCount === 1 ? "" : "s"}, none with a uid`);
    }

    const held = await loadConnection(live, handover.vault);
    await saveConnection(live, handover.vault, {
      sessionId: session.sessionId,
      accounts: session.accounts,
      validUntil: handover.validUntil || "",
      connectedAt: new Date().toISOString(),
      // Keep where the last fetch got to, so reconnecting does not refetch
      // everything and does not lose its place either.
      fetchedTo: (held && held.fetchedTo) || "",
    });

    return home("connected", `${session.accounts.length} account${session.accounts.length === 1 ? "" : "s"}`);
  } catch (err) {
    console.error("bank callback failed:", err.status || "", err.message);
    return home("failed", `${err.status || "no status"}: ${String(err.message).slice(0, 140)}`);
  }
}
