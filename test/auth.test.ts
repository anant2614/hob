import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { authenticate, verifyAccessJwt } from "../src/auth/access";
import { stripInternalHeaders } from "../src/auth/headers";
import { agentName } from "../src/auth/principal";

const TEAM = "https://hob-test.cloudflareaccess.com";
const AUD = "aud-tag-123";
const OWNER = "Owner@Example.com";

let signingKey: CryptoKey;
let otherKey: CryptoKey;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  signingKey = pair.privateKey;
  otherKey = (await generateKeyPair("RS256")).privateKey;
  const publicJwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" };
  jwks = createLocalJWKSet({ keys: [publicJwk] });
});

async function token(
  claims: Record<string, unknown> = {},
  options: { key?: CryptoKey; issuer?: string; audience?: string; expires?: string } = {}
): Promise<string> {
  return new SignJWT({ email: "owner@example.com", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(options.issuer ?? TEAM)
    .setAudience(options.audience ?? AUD)
    .setIssuedAt()
    .setExpirationTime(options.expires ?? "10m")
    .sign(options.key ?? signingKey);
}

const config = { teamDomain: TEAM, audience: AUD, ownerEmail: OWNER };

describe("verifyAccessJwt", () => {
  it("accepts the owner's Access token, whatever the email's case", async () => {
    expect(await verifyAccessJwt(await token(), jwks, config)).toBe(true);
  });

  it.each([
    ["another user", () => token({ email: "someone@example.com" })],
    ["a service token with no email", () => token({ email: undefined, common_name: "svc" })],
    ["the wrong audience", () => token({}, { audience: "other-app" })],
    ["the wrong issuer", () => token({}, { issuer: "https://evil.cloudflareaccess.com" })],
    ["an expired token", () => token({}, { expires: "-1m" })],
    ["a token signed by another key", () => token({}, { key: otherKey })]
  ])("rejects %s", async (_name, make) => {
    expect(await verifyAccessJwt(await make(), jwks, config)).toBe(false);
  });

  it("rejects garbage", async () => {
    expect(await verifyAccessJwt("not.a.jwt", jwks, config)).toBe(false);
  });
});

describe("authenticate", () => {
  const env = {
    TEAM_DOMAIN: `${TEAM}/`,
    ACCESS_AUD: AUD,
    OWNER_EMAIL: OWNER,
    OWNER_USER_ID: "usr_owner",
    DEV_AUTH: undefined as string | undefined
  };

  it("maps a valid Access token to the owner's internal id", async () => {
    const request = new Request("https://agent.example.com/chat", {
      headers: { "cf-access-jwt-assertion": await token() }
    });
    expect(await authenticate(request, env, jwks)).toEqual({ userId: "usr_owner" });
  });

  it("rejects a request without a token", async () => {
    expect(await authenticate(new Request("https://agent.example.com/chat"), env, jwks)).toBeNull();
  });

  it("lets localhost through only when DEV_AUTH is set", async () => {
    const local = new Request("http://localhost:5173/chat");
    expect(await authenticate(local, env, jwks)).toBeNull();
    expect(await authenticate(local, { ...env, DEV_AUTH: "1" }, jwks)).toEqual({ userId: "usr_owner" });
    expect(
      await authenticate(new Request("https://agent.example.com/chat"), { ...env, DEV_AUTH: "1" }, jwks)
    ).toBeNull();
  });
});

describe("agentName", () => {
  it("names the object after the internal user id", () => {
    expect(agentName({ userId: "usr_owner" })).toBe("u:usr_owner");
  });

  it("refuses an empty id", () => {
    expect(() => agentName({ userId: "" })).toThrow();
  });
});

describe("stripInternalHeaders", () => {
  it("drops framework-internal and credential headers, keeping the rest", () => {
    const headers = new Headers({
      upgrade: "websocket",
      "sec-websocket-key": "abc",
      "x-agents-lifecycle-props": "eyJldmlsIjp0cnVlfQ",
      "x-partykit-props": "{}",
      "x-cf-agents-subagent-url": "https://evil.example/",
      "cf-access-jwt-assertion": "jwt",
      cookie: "CF_Authorization=jwt"
    });
    expect([...stripInternalHeaders(headers).keys()].sort()).toEqual(["sec-websocket-key", "upgrade"]);
  });
});
