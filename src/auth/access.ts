import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Principal } from "./principal";

export type AccessConfig = {
  /** https://<team>.cloudflareaccess.com, the `iss` of Access JWTs. */
  readonly teamDomain: string;
  /** The Access application's audience (AUD) tag. */
  readonly audience: string;
  readonly ownerEmail: string;
};

export type AuthEnv = {
  readonly TEAM_DOMAIN: string;
  readonly ACCESS_AUD: string;
  readonly OWNER_EMAIL: string;
  readonly OWNER_USER_ID: string;
  readonly DEV_AUTH?: string | undefined;
};

/** Whether `token` is a valid Access JWT for this application and the owner's email. */
export async function verifyAccessJwt(token: string, jwks: JWTVerifyGetKey, config: AccessConfig): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: config.teamDomain,
      audience: config.audience,
      algorithms: ["RS256"]
    });
    return typeof payload.email === "string" && payload.email.toLowerCase() === config.ownerEmail.trim().toLowerCase();
  } catch {
    return false;
  }
}

// Module scope, so the key set and its cache outlive one request. Access
// rotates keys every 6 weeks; jose refetches when it meets an unknown `kid`.
let remote: { readonly url: string; readonly jwks: JWTVerifyGetKey } | undefined;

function remoteJwks(teamDomain: string): JWTVerifyGetKey {
  const url = `${teamDomain}/cdn-cgi/access/certs`;
  if (remote?.url !== url) remote = { url, jwks: createRemoteJWKSet(new URL(url)) };
  return remote.jwks;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * Turn a request into the owner's principal, or null. Production requests must
 * carry the Cf-Access-Jwt-Assertion header that the hostname's Access
 * application adds. Local development may skip Access only on a loopback
 * hostname and only with DEV_AUTH=1, which lives in .dev.vars and never in
 * production.
 */
export async function authenticate(request: Request, env: AuthEnv, jwks?: JWTVerifyGetKey): Promise<Principal | null> {
  const owner: Principal = { userId: env.OWNER_USER_ID };
  if (env.DEV_AUTH === "1" && isLoopback(new URL(request.url).hostname)) return owner;

  const token = request.headers.get("cf-access-jwt-assertion");
  if (token === null || token === "" || !env.ACCESS_AUD) return null;
  const teamDomain = env.TEAM_DOMAIN.replace(/\/+$/, "");
  const valid = await verifyAccessJwt(token, jwks ?? remoteJwks(teamDomain), {
    teamDomain,
    audience: env.ACCESS_AUD,
    ownerEmail: env.OWNER_EMAIL
  });
  return valid ? owner : null;
}
