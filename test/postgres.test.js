import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { runMigrations } from "../src/db.js";
import { bindPublicationChannels, formatPublication } from "../src/format.js";
import { PostgresSaasStore } from "../src/postgres-store.js";

const WS_A = "a1000000-0000-4000-8000-000000000001";
const WS_B = "a1000000-0000-4000-8000-000000000002";
const USER_A = "a2000000-0000-4000-8000-000000000001";
const USER_B = "a2000000-0000-4000-8000-000000000002";
const CHANNEL_A = "a3000000-0000-4000-8000-000000000001";
const CHANNEL_B = "a3000000-0000-4000-8000-000000000002";
const SUBJECT_A = "a4000000-0000-4000-8000-000000000001";
const SUBJECT_B = "a4000000-0000-4000-8000-000000000002";
const GRANT_A = "a5000000-0000-4000-8000-000000000001";

async function databaseFixture({ clock = () => new Date("2026-08-29T08:00:00.000Z") } = {}) {
  const database = newDb({ noAstCoverageCheck: true });
  const adapter = database.adapters.createPg();
  const pool = new adapter.Pool();
  await runMigrations(pool);
  const store = new PostgresSaasStore(pool, { clock });
  await store.addWorkspace({ id: WS_A, name: "Workspace A" });
  await store.addWorkspace({ id: WS_B, name: "Workspace B" });
  await store.addUser({ id: USER_A, workspaceId: WS_A, email: "a@example.test" });
  await store.addUser({ id: USER_B, workspaceId: WS_B, email: "b@example.test" });
  await store.addChannel({
    id: CHANNEL_A,
    workspaceId: WS_A,
    telegramChatId: "@workspace_a",
    title: "Workspace A channel",
    name: "A channel",
    botPermissions: { canPostMessages: true },
    isDefault: true,
  });
  await store.addChannel({
    id: CHANNEL_B,
    workspaceId: WS_B,
    telegramChatId: "@workspace_b",
    title: "Workspace B channel",
    name: "B channel",
    botPermissions: { canPostMessages: true },
    isDefault: true,
  });
  await store.addAuthSubject({
    id: SUBJECT_A,
    issuer: "https://identity.example.test",
    subject: "subject-a",
    userId: USER_A,
    workspaceId: WS_A,
  });
  await store.addAuthSubject({
    id: SUBJECT_B,
    issuer: "https://identity.example.test",
    subject: "subject-b",
    userId: USER_B,
    workspaceId: WS_B,
  });
  return { database, pool, store, clock };
}

function principalA(overrides = {}) {
  return {
    authSubjectId: SUBJECT_A,
    credentialId: SUBJECT_A,
    userId: USER_A,
    workspaceId: WS_A,
    automationGrantId: null,
    allowDuplicatePublish: false,
    scopes: ["channels.read", "previews.write", "publications.write"],
    ...overrides,
  };
}

async function createPreview(store, text, { workspaceId = WS_A, channelId = CHANNEL_A } = {}) {
  const telegramId = workspaceId === WS_A ? "@workspace_a" : "@workspace_b";
  const channelName = workspaceId === WS_A ? "A channel" : "B channel";
  const formatted = bindPublicationChannels(formatPublication({ markdown: text }), [
    { id: telegramId, name: channelName },
  ]);
  return store.createPreview({
    workspaceId,
    channelIds: [channelId],
    hash: formatted.sha256,
    content: formatted.markdown,
    options: { publicationFormat: formatted.publicationFormat, images: [] },
    formatted,
    ttlSeconds: 900,
  });
}

function successfulResult(attempt, messageId = 101) {
  const publications = [
    ...attempt.duplicatePublications,
    ...attempt.publishChannels.map((channel) => ({
      channelId: channel.id,
      channelName: channel.name,
      chatId: channel.telegramChatId,
      status: "published",
      messageId,
      channelTitle: channel.title,
      publishedAt: "2026-08-29T08:00:01.000Z",
      url: "https://t.me/workspace_a/101",
      error: null,
    })),
  ];
  return {
    status: "complete",
    publicationFormat: attempt.preview.formatted.publicationFormat,
    sha256: attempt.preview.formatted.sha256,
    channelIds: attempt.channels.map((channel) => channel.id),
    channels: attempt.channels.map((channel) => channel.name),
    publishedCount: publications.filter((item) => item.status === "published").length,
    duplicatePreventedCount: publications.filter(
      (item) => item.status === "duplicate_prevented",
    ).length,
    failedCount: 0,
    publications,
  };
}

test("PostgreSQL migrations are idempotent and create the durable P0 schema", async (t) => {
  const { pool } = await databaseFixture();
  t.after(() => pool.end());
  await runMigrations(pool);
  const migrations = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
  assert.deepEqual(migrations.rows.map((row) => row.version), [
    "001_initial.sql",
    "002_onboarding_admin.sql",
  ]);
  for (const table of [
    "workspaces",
    "auth_subjects",
    "telegram_channels",
    "previews",
    "automation_usage",
    "publication_attempts",
    "publication_fingerprints",
    "audit_events",
    "telegram_onboarding_challenges",
    "telegram_identities",
    "telegram_webhook_updates",
  ]) {
    const found = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1",
      [table],
    );
    assert.equal(found.rowCount, 1, `${table} migration is missing`);
  }
});

test("PostgreSQL repository never resolves another workspace's channels or previews", async (t) => {
  const { pool, store } = await databaseFixture();
  t.after(() => pool.end());
  assert.deepEqual((await store.listChannels(WS_A)).map((channel) => channel.id), [CHANNEL_A]);
  assert.deepEqual((await store.listChannels(WS_B)).map((channel) => channel.id), [CHANNEL_B]);
  await assert.rejects(() => store.resolveChannels(WS_A, [CHANNEL_B]), /not available/);
  const previewB = await createPreview(store, "Tenant B private post", {
    workspaceId: WS_B,
    channelId: CHANNEL_B,
  });
  assert.equal(await store.getPreview(WS_A, previewB.id), null);
  await assert.rejects(
    () =>
      store.beginPublication({
        principal: principalA(),
        previewId: previewB.id,
        previewSha256: previewB.hash,
      }),
    /does not exist in this workspace/,
  );
  assert.equal(
    (await store.resolveOAuthPrincipal({
      issuer: "https://identity.example.test",
      subject: "subject-a",
      workspaceId: WS_B,
    })).workspaceId,
    WS_A,
  );
});

test("two store instances share preview claims, idempotency, recovery, and audit", async (t) => {
  const { pool, store: storeA } = await databaseFixture();
  t.after(() => pool.end());
  const storeB = new PostgresSaasStore(pool, { clock: storeA.clock });
  const preview = await createPreview(storeA, "Durable exact post");
  const attempt = await storeA.beginPublication({
    principal: principalA(),
    previewId: preview.id,
    previewSha256: preview.hash,
  });
  assert.equal((await storeB.getPreview(WS_A, preview.id)).status, "publishing");
  await assert.rejects(
    () =>
      storeB.beginPublication({
        principal: principalA(),
        previewId: preview.id,
        previewSha256: preview.hash,
      }),
    /already being published/,
  );
  await storeA.completePublicationAttempt(attempt, successfulResult(attempt));

  const afterRestart = new PostgresSaasStore(pool, { clock: storeA.clock });
  assert.equal((await afterRestart.getPreview(WS_A, preview.id)).status, "published");
  assert.equal((await afterRestart.listAuditEvents(WS_A)).length, 1);

  const sameContent = await createPreview(storeB, "Durable exact post");
  const duplicateAttempt = await storeB.beginPublication({
    principal: principalA(),
    previewId: sameContent.id,
    previewSha256: sameContent.hash,
  });
  assert.equal(duplicateAttempt.publishChannels.length, 0);
  assert.equal(duplicateAttempt.duplicatePublications.length, 1);
  await storeB.completePublicationAttempt(duplicateAttempt, successfulResult(duplicateAttempt));
  assert.equal((await storeA.listAuditEvents(WS_A)).at(-1).result, "duplicate_prevented");
});

test("parallel instances claim one preview once and reserve one content fingerprint", async (t) => {
  const { pool, store: storeA } = await databaseFixture();
  t.after(() => pool.end());
  const storeB = new PostgresSaasStore(pool, { clock: storeA.clock });
  const onePreview = await createPreview(storeA, "Same preview race");
  const samePreviewRace = await Promise.allSettled([
    storeA.beginPublication({
      principal: principalA(),
      previewId: onePreview.id,
      previewSha256: onePreview.hash,
    }),
    storeB.beginPublication({
      principal: principalA(),
      previewId: onePreview.id,
      previewSha256: onePreview.hash,
    }),
  ]);
  assert.equal(samePreviewRace.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(samePreviewRace.filter((item) => item.status === "rejected").length, 1);

  const first = await createPreview(storeA, "Same content race");
  const second = await createPreview(storeB, "Same content race");
  const contentRace = await Promise.all([
    storeA.beginPublication({
      principal: principalA(),
      previewId: first.id,
      previewSha256: first.hash,
    }),
    storeB.beginPublication({
      principal: principalA(),
      previewId: second.id,
      previewSha256: second.hash,
    }),
  ]);
  assert.equal(
    contentRace.reduce((count, attempt) => count + attempt.publishChannels.length, 0),
    1,
  );
  assert.equal(
    contentRace.reduce((count, attempt) => count + attempt.duplicatePublications.length, 0),
    1,
  );
});

test("pre-send failure releases a fingerprint while ambiguous failure remains blocked", async (t) => {
  const { pool, store } = await databaseFixture();
  t.after(() => pool.end());
  const preSend = await createPreview(store, "Retryable before Telegram");
  const preSendAttempt = await store.beginPublication({
    principal: principalA(),
    previewId: preSend.id,
    previewSha256: preSend.hash,
  });
  await store.failPublicationAttempt(preSendAttempt, new Error("configuration failed"));
  const retry = await createPreview(store, "Retryable before Telegram");
  const retryAttempt = await store.beginPublication({
    principal: principalA(),
    previewId: retry.id,
    previewSha256: retry.hash,
  });
  assert.equal(retryAttempt.publishChannels.length, 1);
  await store.failPublicationAttempt(retryAttempt, new Error("network uncertain"), {
    ambiguous: true,
  });
  const blocked = await createPreview(store, "Retryable before Telegram");
  const blockedAttempt = await store.beginPublication({
    principal: principalA(),
    previewId: blocked.id,
    previewSha256: blocked.hash,
  });
  assert.equal(blockedAttempt.publishChannels.length, 0);
  assert.equal(blockedAttempt.duplicatePublications.length, 1);
});

test("parallel app instances cannot reserve more than the daily grant quota", async (t) => {
  const { pool, store: storeA } = await databaseFixture();
  t.after(() => pool.end());
  const storeB = new PostgresSaasStore(pool, { clock: storeA.clock });
  await storeA.addAutomationGrant({
    id: GRANT_A,
    workspaceId: WS_A,
    allowedChannelIds: [CHANNEL_A],
    autonomousPublish: true,
    maxPostsPerRun: 1,
    maxPostsPerDay: 1,
  });
  const principal = principalA({ automationGrantId: GRANT_A });
  const first = await createPreview(storeA, "Quota race one");
  const second = await createPreview(storeB, "Quota race two");
  const settled = await Promise.allSettled([
    storeA.beginPublication({
      principal,
      previewId: first.id,
      previewSha256: first.hash,
      publicationMode: "scheduled",
    }),
    storeB.beginPublication({
      principal,
      previewId: second.id,
      previewSha256: second.hash,
      publicationMode: "scheduled",
    }),
  ]);
  assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(settled.filter((item) => item.status === "rejected").length, 1);
  assert.match(settled.find((item) => item.status === "rejected").reason.message, /maxPostsPerDay/);
  const usage = await pool.query(
    "SELECT posts_reserved FROM automation_usage WHERE automation_grant_id = $1",
    [GRANT_A],
  );
  assert.equal(usage.rows[0].posts_reserved, 1);
});

test("restart recovery marks stale attempts ambiguous and keeps their fingerprint blocked", async (t) => {
  let now = new Date("2026-08-29T08:00:00.000Z");
  const { pool, store } = await databaseFixture({ clock: () => now });
  t.after(() => pool.end());
  const preview = await createPreview(store, "Crash recovery post");
  const attempt = await store.beginPublication({
    principal: principalA(),
    previewId: preview.id,
    previewSha256: preview.hash,
  });
  now = new Date("2026-08-29T08:05:01.000Z");
  const restarted = new PostgresSaasStore(pool, { clock: () => now });
  assert.deepEqual(await restarted.recoverStalePublicationAttempts(), {
    recoveredAttempts: 1,
  });
  assert.equal((await restarted.getPreview(WS_A, preview.id)).status, "cancelled");
  assert.equal((await restarted.listAuditEvents(WS_A)).at(-1).result, "ambiguous_recovered");
  await restarted.failPublicationAttempt(attempt, new Error("late caller failure"));
  assert.equal((await restarted.getPreview(WS_A, preview.id)).status, "cancelled");

  const sameContent = await createPreview(restarted, "Crash recovery post");
  const duplicate = await restarted.beginPublication({
    principal: principalA(),
    previewId: sameContent.id,
    previewSha256: sameContent.hash,
  });
  assert.equal(duplicate.publishChannels.length, 0);
  assert.equal(duplicate.duplicatePublications.length, 1);
});

test("retention job expires previews and removes old preview, audit, and revocation rows", async (t) => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const { pool, store } = await databaseFixture({ clock: () => now });
  t.after(() => pool.end());
  const preview = await createPreview(store, "Old unconfirmed preview");
  await store.revokeToken({
    issuer: "https://identity.example.test",
    jti: "old-token",
    expiresAt: new Date("2026-01-02T00:00:00.000Z"),
  });
  const storedRevocation = await pool.query(
    "SELECT jti, expires_at FROM revoked_tokens WHERE issuer = $1",
    ["https://identity.example.test"],
  );
  assert.equal(storedRevocation.rowCount, 1);
  assert.equal(
    new Date(storedRevocation.rows[0].expires_at).toISOString(),
    "2026-01-02T00:00:00.000Z",
  );
  await store.appendAudit({
    workspaceId: WS_A,
    initiatorUserId: USER_A,
    authSubjectId: SUBJECT_A,
    publicationMode: "interactive",
    previewId: preview.id,
    channelId: CHANNEL_A,
    telegramChatId: "@workspace_a",
    result: "denied",
    error: "old audit event",
  });
  now = new Date("2026-04-15T00:00:00.000Z");
  const expiredRevocation = await pool.query(
    "SELECT jti FROM revoked_tokens WHERE expires_at <= $1",
    [now],
  );
  assert.equal(expiredRevocation.rowCount, 1);
  const result = await store.cleanupRetention({
    previewRetentionDays: 7,
    auditRetentionDays: 90,
  });
  assert.deepEqual(result, {
    expiredPreviews: 1,
    deletedRevokedTokens: 1,
    deletedAuditEvents: 1,
    deletedPreviews: 1,
  });
  assert.equal(await store.getPreview(WS_A, preview.id), null);
});
