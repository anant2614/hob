/**
 * Headers the Agents SDK trusts when they reach a Durable Object: the lifecycle
 * decodes `x-agents-lifecycle-props` from any request, and
 * `x-cf-agents-subagent-url` is read on connect. A client must never be able to
 * set them, so the edge drops the whole families.
 */
const INTERNAL_PREFIXES = ["x-agents-", "x-cf-agents-", "x-partykit-"];
/** Credentials the agent never needs to see. */
const CREDENTIALS = new Set(["cf-access-jwt-assertion", "cookie", "authorization"]);

export function stripInternalHeaders(headers: Headers): Headers {
  const clean = new Headers(headers);
  for (const name of [...clean.keys()]) {
    if (CREDENTIALS.has(name) || INTERNAL_PREFIXES.some((prefix) => name.startsWith(prefix))) clean.delete(name);
  }
  return clean;
}
