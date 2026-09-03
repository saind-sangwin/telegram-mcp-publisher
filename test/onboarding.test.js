import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { runMigrations } from "../src/db.js";
import { PostgresSaasStore } from "../src/postgres-store.js";
import { createHttpApp } from "../src/server.js";

const ISSUER = "https://identity.example.test";
const ALL_SCOPES = [
  "channels.read",
  "previews.write",
  "publications.write",
  "automations.manage",
  "onboarding.write",
];

async function fixture() {
  const database = newDb({ noAstCoverageCheck: true });
  const adapter = database.adapters.createPg();
  const pool = new adapter.Pool();
  await runMigrations(pool);
  const store = new PostgresSaasStore(pool, {
    clock: () => new Date("2026-08-30T06:00:00.000Z"),
  });
  const identities = new Map([
    ["owner-a", { subject: "owner-a", email: "owner-a@example.test" }],
    ["owner-b", { subject: "owner-b", email: "owner-b@example.test" }],
  ]);
  const authenticator = {
    kind: "oauth-jwt",
    async verify(token) {
      const identity = identities.get(token);
      if (!identity) throw new Error("invalid token");
      return {
        issuer: ISSUER,
        subject: identity.subject,
        jti: `jti-${identity.subject}`,
        scopes: ALL_SCOPES,
        claims: { email: identity.email, email_verified: true },
      };
    },
    async authenticate(token) {
      const verified = await this.verify(token);
      const principal = await store.resolveOAuthPrincipal(verified);
      if (!principal) throw new Error("not linked");
      return { ...principal, ...verified };
    },
  };

  const telegramCalls = [];
  const telegramFetchImpl = async (url, init) => {
    const method = new URL(url).pathname.split("/").at(-1);
    const body = init.body ? JSON.parse(init.body) : {};
    telegramCalls.push({ method, body });
    let result;
    if (method === "getMe") {
      result = { id: 9001, is_bot: true, username: "shared_onboarding_bot" };
    } else if (method === "sendMessage") {
      result = { message_id: 1, date: 1_788_066_000, chat: { id: body.chat_id, type: "private" } };
    } else if (method === "getChat") {
      result = { id: -100777, type: "channel", title: "Verified channel", username: "verified_channel" };
    } else if (method === "getChatMember" && Number(body.user_id) === 9001) {
      result = { status: "administrator", can_post_messages: true, can_edit_messages: true };
    } else if (method === "getChatMember") {
      result = { status: "creator", user: { id: body.user_id } };
    } else {
      throw new Error(`Unexpected Telegram method ${method}`);
    }
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const env = {
    PUBLIC_BASE_URL: "https://publisher.example.test",
    OAUTH_ISSUER: ISSUER,
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_WEBHOOK_SECRET: "w".repeat(32),
    ONBOARDING_TOKEN_PEPPER: "p".repeat(32),
  };
  const server = createHttpApp({ env, store, authenticator, telegramFetchImpl });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { pool, store, server, base, env, telegramCalls };
}

async function api(base, path, { token, method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json();
  return { response, payload };
}

async function bootstrap(base, token, workspaceName) {
  return api(base, "/api/onboarding/bootstrap", {
    token,
    method: "POST",
    body: { workspaceName },
  });
}

async function linkChallenge(base, env, token, telegramUserId, updateId) {
  const challenge = await api(base, "/api/onboarding/challenges", {
    token,
    method: "POST",
    body: {},
  });
  assert.equal(challenge.response.status, 201);
  const startToken = new URL(challenge.payload.telegramDeepLink).searchParams
    .get("start")
    .replace(/^connect_/, "");
  const webhook = await api(base, "/api/telegram/webhook", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": env.TELEGRAM_WEBHOOK_SECRET },
    body: {
      update_id: updateId,
      message: {
        text: `/start connect_${startToken}`,
        chat: { id: telegramUserId, type: "private" },
        from: { id: telegramUserId, username: `telegram_${telegramUserId}` },
      },
    },
  });
  assert.deepEqual(webhook.payload, { ok: true, linked: true });
  return challenge.payload;
}

test("OAuth bootstrap, Telegram admin proof, tenant claim, policies, and revocation form one safe vertical slice", async (t) => {
  const { pool, store, server, base, env, telegramCalls } = await fixture();
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  });

  const missing = await api(base, "/api/me");
  assert.equal(missing.response.status, 401);

  const ownerA = await bootstrap(base, "owner-a", "Workspace A");
  assert.equal(ownerA.response.status, 201);
  assert.equal(ownerA.payload.membership.role, "owner");
  const idempotent = await bootstrap(base, "owner-a", "Ignored rename");
  assert.equal(idempotent.response.status, 200);
  assert.equal(idempotent.payload.workspace.id, ownerA.payload.workspace.id);
  assert.equal(idempotent.payload.workspace.name, "Workspace A");

  const badWebhook = await api(base, "/api/telegram/webhook", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": "wrong" },
    body: { update_id: 1 },
  });
  assert.equal(badWebhook.response.status, 401);

  const challengeA = await linkChallenge(base, env, "owner-a", 777, 1001);
  const verified = await api(
    base,
    `/api/onboarding/challenges/${challengeA.id}/verify`,
    {
      token: "owner-a",
      method: "POST",
      body: { telegramChatId: "@verified_channel", name: "Main", isDefault: true },
    },
  );
  assert.equal(verified.response.status, 201);
  assert.equal(verified.payload.channel.telegramChatId, "-100777");
  assert.equal(verified.payload.channel.botPermissions.canPostMessages, true);
  assert.equal(verified.payload.channel.isDefault, true);
  const channelId = verified.payload.channel.id;

  const channelsA = await api(base, "/api/channels", { token: "owner-a" });
  assert.deepEqual(channelsA.payload.channels.map((channel) => channel.id), [channelId]);
  assert.deepEqual((await store.listChannels(ownerA.payload.workspace.id)).map((channel) => channel.id), [channelId]);

  const grantResponse = await api(base, "/api/automation-grants", {
    token: "owner-a",
    method: "POST",
    body: {
      channelIds: [channelId],
      autonomousPublish: true,
      maxPostsPerRun: 1,
      maxPostsPerDay: 3,
      bindCurrentSubject: true,
    },
  });
  assert.equal(grantResponse.response.status, 201);
  assert.equal(grantResponse.payload.grant.autonomousPublish, true);
  const linkedPrincipal = await store.resolveOAuthPrincipal({ issuer: ISSUER, subject: "owner-a" });
  assert.equal(linkedPrincipal.automationGrantId, grantResponse.payload.grant.id);

  const revoked = await api(
    base,
    `/api/automation-grants/${grantResponse.payload.grant.id}/revoke`,
    { token: "owner-a", method: "POST", body: {} },
  );
  assert.equal(revoked.response.status, 200);
  assert.equal(revoked.payload.grant.status, "revoked");
  assert.equal(
    (await store.resolveOAuthPrincipal({ issuer: ISSUER, subject: "owner-a" })).automationGrantId,
    null,
  );

  const ownerB = await bootstrap(base, "owner-b", "Workspace B");
  assert.equal(ownerB.response.status, 201);
  const challengeB = await linkChallenge(base, env, "owner-b", 778, 1002);
  const duplicateClaim = await api(
    base,
    `/api/onboarding/challenges/${challengeB.id}/verify`,
    { token: "owner-b", method: "POST", body: { telegramChatId: "@verified_channel" } },
  );
  assert.equal(duplicateClaim.response.status, 409);
  assert.match(duplicateClaim.payload.message, /another workspace/);

  const crossTenantDisable = await api(base, `/api/channels/${channelId}/disable`, {
    token: "owner-b",
    method: "POST",
    body: {},
  });
  assert.equal(crossTenantDisable.response.status, 404);
  const disabled = await api(base, `/api/channels/${channelId}/disable`, {
    token: "owner-a",
    method: "POST",
    body: {},
  });
  assert.equal(disabled.response.status, 200);
  assert.equal(disabled.payload.channel.status, "disabled");
  assert.deepEqual(await store.listChannels(ownerA.payload.workspace.id), []);

  const audit = await api(base, "/api/audit?limit=20", { token: "owner-a" });
  assert.equal(audit.response.status, 200);
  assert.ok(audit.payload.events.some((event) => event.result === "telegram_channel_connected"));
  assert.ok(audit.payload.events.some((event) => event.result === "automation_grant_revoked"));
  assert.ok(telegramCalls.some((call) => call.method === "getChatMember" && Number(call.body.user_id) === 777));
});
