import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  OAuthAuthenticationError,
  authenticateAuthorizationHeader,
  createJwtBearerAuthenticator,
} from "../src/oauth.js";
import { createDigestServer, createHttpApp } from "../src/server.js";
import { InMemorySaasStore } from "../src/saas-store.js";

const ISSUER = "https://identity.example.test";
const AUDIENCE = "https://publisher.example.test/mcp";
const WORKSPACE_A = "d1000000-0000-4000-8000-000000000001";
const WORKSPACE_B = "d1000000-0000-4000-8000-000000000002";
const USER_A = "d2000000-0000-4000-8000-000000000001";
const SUBJECT_A = "oauth-user-a";

async function oauthFixture() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key-1";
  jwk.use = "sig";
  jwk.alg = "RS256";
  const store = new InMemorySaasStore();
  store.addWorkspace({ id: WORKSPACE_A, name: "Workspace A" });
  store.addWorkspace({ id: WORKSPACE_B, name: "Workspace B" });
  store.addUser({ id: USER_A, workspaceId: WORKSPACE_A });
  store.addChannel({
    id: "d3000000-0000-4000-8000-000000000001",
    workspaceId: WORKSPACE_A,
    telegramChatId: "@workspace_a",
    title: "Workspace A",
    name: "Workspace A",
    botPermissions: { canPostMessages: true },
    isDefault: true,
  });
  store.addAuthSubject({
    id: "d4000000-0000-4000-8000-000000000001",
    issuer: ISSUER,
    subject: SUBJECT_A,
    userId: USER_A,
    workspaceId: WORKSPACE_A,
  });
  const authenticator = createJwtBearerAuthenticator(
    {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["RS256"],
      requireJti: true,
      requiredTyp: "at+jwt",
      clockToleranceSeconds: 0,
    },
    { store, jwks: { keys: [jwk] } },
  );
  return { store, privateKey, authenticator };
}

async function signAccessToken(
  privateKey,
  {
    issuer = ISSUER,
    audience = AUDIENCE,
    subject = SUBJECT_A,
    scopes = ["channels.read", "previews.write", "publications.write"],
    issuedAt = Math.floor(Date.now() / 1000),
    expiresAt = Math.floor(Date.now() / 1000) + 300,
    notBefore,
    jti = "token-1",
    extra = {},
  } = {},
) {
  let token = new SignJWT({ scope: scopes.join(" "), ...extra })
    .setProtectedHeader({ alg: "RS256", kid: "test-key-1", typ: "at+jwt" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt);
  if (notBefore !== undefined) token = token.setNotBefore(notBefore);
  if (jti !== null) token = token.setJti(jti);
  return token.sign(privateKey);
}

test("JWT verifier maps issuer/sub server-side and ignores tenant claims", async () => {
  const { privateKey, authenticator } = await oauthFixture();
  const token = await signAccessToken(privateKey, {
    extra: { workspace_id: WORKSPACE_B, user_id: "attacker-selected" },
  });
  const principal = await authenticator.authenticate(token);
  assert.equal(principal.workspaceId, WORKSPACE_A);
  assert.equal(principal.userId, USER_A);
  assert.deepEqual(principal.scopes, [
    "channels.read",
    "previews.write",
    "publications.write",
  ]);
  assert.equal(principal.jti, "token-1");
});

test("JWT verifier rejects wrong issuer, audience, expiry, not-before, and missing jti", async () => {
  const { privateKey, authenticator } = await oauthFixture();
  const { privateKey: forgedPrivateKey } = await generateKeyPair("RS256");
  const now = Math.floor(Date.now() / 1000);
  const invalidTokens = [
    await signAccessToken(privateKey, { issuer: "https://evil.example", jti: "wrong-iss" }),
    await signAccessToken(privateKey, { audience: "https://other.example/mcp", jti: "wrong-aud" }),
    await signAccessToken(privateKey, { audience: [AUDIENCE, "https://other.example/mcp"], jti: "mixed-aud" }),
    await signAccessToken(privateKey, { issuedAt: now - 600, expiresAt: now - 1, jti: "expired" }),
    await signAccessToken(privateKey, { notBefore: now + 60, jti: "future" }),
    await signAccessToken(privateKey, { jti: null }),
    await signAccessToken(forgedPrivateKey, { jti: "forged-signature" }),
  ];
  for (const token of invalidTokens) {
    await assert.rejects(() => authenticator.authenticate(token), OAuthAuthenticationError);
    assert.equal(await authenticateAuthorizationHeader(`Bearer ${token}`, authenticator), null);
  }
});

test("revocation and unlinked OAuth subjects immediately deny access", async () => {
  const { store, privateKey, authenticator } = await oauthFixture();
  const token = await signAccessToken(privateKey, { jti: "revocable" });
  assert.ok(await authenticator.authenticate(token));
  store.revokeToken({ issuer: ISSUER, jti: "revocable" });
  await assert.rejects(() => authenticator.authenticate(token), /revoked/);

  const unlinked = await signAccessToken(privateKey, {
    subject: "not-linked",
    jti: "unlinked",
  });
  await assert.rejects(() => authenticator.authenticate(unlinked), /not linked/);
});

test("tool scopes are enforced with a runtime OAuth challenge", async (t) => {
  const { store, privateKey, authenticator } = await oauthFixture();
  const token = await signAccessToken(privateKey, {
    scopes: ["channels.read"],
    jti: "read-only",
  });
  const principal = await authenticator.authenticate(token);
  const server = createDigestServer(
    {
      PUBLIC_BASE_URL: "https://publisher.example.test",
      TELEGRAM_BOT_TOKEN: "unused",
    },
    { store, principal },
  );
  const client = new Client({ name: "oauth-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const listed = await client.callTool({ name: "list_channels", arguments: {} });
  assert.equal(listed.structuredContent.channels.length, 1);
  const denied = await client.callTool({
    name: "preview_digest",
    arguments: { markdown: "Must not be prepared" },
  });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /previews\.write/);
  assert.match(denied._meta["mcp/www_authenticate"][0], /insufficient_scope/);
  assert.match(denied._meta["mcp/www_authenticate"][0], /scope="previews\.write"/);
  assert.equal(store.previews.size, 0);
});

test("production OAuth configuration pins HTTPS issuer, JWKS, and canonical resource audience", async () => {
  const { store } = await oauthFixture();
  const baseline = {
    DATABASE_URL: "postgres://unused.example/test",
    PUBLIC_BASE_URL: "https://publisher.example.test",
    OAUTH_ISSUER: ISSUER,
    OAUTH_JWKS_URI: `${ISSUER}/.well-known/jwks.json`,
    ONBOARDING_TOKEN_PEPPER: "p".repeat(32),
    TELEGRAM_WEBHOOK_SECRET: "w".repeat(32),
  };
  assert.throws(
    () => createHttpApp({ store, env: { ...baseline, OAUTH_JWKS_URI: "" } }),
    /requires OAUTH_JWKS_URI/,
  );
  assert.throws(
    () =>
      createHttpApp({
        store,
        env: { ...baseline, PUBLIC_BASE_URL: "http://publisher.example.test" },
      }),
    /PUBLIC_BASE_URL must use HTTPS/,
  );
  assert.throws(
    () =>
      createHttpApp({
        store,
        env: { ...baseline, OAUTH_AUDIENCE: "https://publisher.example.test/other" },
      }),
    /must equal the canonical MCP resource/,
  );
});
