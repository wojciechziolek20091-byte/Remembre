import { store } from "./_store.js";
import { bankSession } from "./_bank.js";
import { handoverKey, loadConnection, readJson, saveConnection } from "./_bankstore.js";

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

  const home = (outcome) => {
    res.statusCode = 302;
    res.setHeader("Location", `/?bank=${encodeURIComponent(outcome)}`);
    res.setHeader("Cache-Control", "no-store");
    res.end();
  };

  if (refused) return home("refused");
  if (!code || !/^[a-f0-9]{16,}$/i.test(state)) return home("bad-return");

  const live = store();
  if (!live) return home("no-store");

  try {
    const handover = await readJson(live, handoverKey(state), null);
    // The nonce is good once. A replayed return should not attach somebody
    // else's bank session to a vault.
    await live.put(handoverKey(state), "");
    if (!handover || !handover.vault) return home("expired");

    const session = await bankSession(code);
    if (session.accounts.length === 0) return home("no-accounts");

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

    return home("connected");
  } catch (err) {
    console.error("bank callback failed:", err.status || "", err.message);
    return home("failed");
  }
}
