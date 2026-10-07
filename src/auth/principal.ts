/** Who a request is from, as Hob's own opaque id (never the identity provider's subject). */
export type Principal = { readonly userId: string };

/**
 * The ONLY function that builds Durable Object names. The browser never picks
 * one; whoever reaches an object can reach everything in it.
 */
export function agentName(principal: Principal): string {
  if (principal.userId.trim() === "") throw new Error("Principal has no user id");
  return `u:${principal.userId}`;
}
