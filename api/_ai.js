/*
  The analysis half's connection to Claude.

  One dependency, deliberately: the official SDK. Everything else under api/ is
  dependency-free, and giving that up is worth saying out loud -- but a
  hand-rolled client for an API with retries, typed errors and streaming is how
  subtle bugs get in, and the supported path is the one that keeps working.

  The key lives in an environment variable and leaves this file in nothing: not
  a return value, not a log line, not an error message.
*/

import Anthropic from "@anthropic-ai/sdk";

/* The default and the one to use unless somebody deliberately changes it. */
export const MODEL = "claude-opus-5-5";

/**
 * The shape of a value that is not what was expected. Counts and yes-or-nos
 * only -- never a character of it. A key that is the wrong key is still a key.
 */
function describeValue(raw) {
  const text = String(raw);
  return {
    length: text.length,
    startsWithSkAnt: text.startsWith("sk-ant-"),
    looksLikeAdminKey: text.startsWith("sk-ant-admin"),
    hasQuotes: /^["']|["']$/.test(text.trim()),
    hasSpaces: /\s/.test(text.trim()),
    looksLikePem: /BEGIN|PRIVATE KEY/.test(text),
    looksLikeUuid: /^[0-9a-f-]{20,40}$/i.test(text.trim()),
  };
}

export function aiReport() {
  const raw = process.env.ANTHROPIC_API_KEY || "";
  const key = raw.trim().replace(/^["']|["']$/g, "");

  if (!key) return { configured: false, problem: "ANTHROPIC_API_KEY is not set." };

  if (!key.startsWith("sk-ant-")) {
    return {
      configured: false,
      problem: "ANTHROPIC_API_KEY does not look like an API key: they begin sk-ant-.",
      sawInstead: describeValue(raw),
    };
  }

  // An Admin key manages the organisation and cannot call the Messages API --
  // an easy one to copy by mistake from the Console, and a confusing 401 later.
  if (key.startsWith("sk-ant-admin")) {
    return {
      configured: false,
      problem: "That is an Admin API key. The analysis needs an ordinary API key from the Console's API Keys page.",
    };
  }

  if (key.length < 40) {
    return { configured: false, problem: "ANTHROPIC_API_KEY looks truncated.", sawInstead: describeValue(raw) };
  }

  return { configured: true, problem: "", model: MODEL };
}

/** The client, or null when there is nothing usable to build one from. */
export function aiClient() {
  if (!aiReport().configured) return null;
  return new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY.trim().replace(/^["']|["']$/g, ""),
    // A serverless function should give up well before the platform does, and
    // a retry inside a 60-second budget would only be killed mid-flight.
    timeout: 50 * 1000,
    maxRetries: 1,
  });
}

/**
 * Proves the key works without spending anything.
 *
 * Counting tokens authenticates exactly like a real request and is not billed,
 * so this can be run as often as it is useful.
 */
export async function aiCheck() {
  const client = aiClient();
  if (!client) throw new Error(aiReport().problem);

  const counted = await client.messages.countTokens({
    model: MODEL,
    messages: [{ role: "user", content: "ping" }],
  });

  return { model: MODEL, tokens: counted.input_tokens };
}
