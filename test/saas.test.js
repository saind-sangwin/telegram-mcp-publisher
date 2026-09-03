import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Writable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  authenticateMcpRequest,
  createDigestServer,
  createHttpApp,
} from "../src/server.js";
import { InMemorySaasStore } from "../src/saas-store.js";

const TOKEN_A = "tenant-a-token-0123456789abcdef";
const TOKEN_B = "tenant-b-token-0123456789abcdef";

function tenantFixture({ clock } = {}) {
  const store = new InMemorySaasStore(clock ? { clock } : undefined);
  store.addWorkspace({ id: "workspace-a", name: "Workspace A" });
  store.addWorkspace({ id: "workspace-b", name: "Workspace B" });
  store.addUser({ id: "user-a", workspaceId: "workspace-a" });
  store.addUser({ id: "user-b", workspaceId: "workspace-b" });
  store.addChannel({
    id: "channel-a",
    workspaceId: "workspace-a",
    telegramChatId: "@tenant_a_channel",
    title: "Tenant A Channel",
    name: "A channel",
    username: "tenant_a_channel",
    botPermissions: { canPostMessages: true, canEditMessages: true },
    isDefault: true,
  });
  store.addChannel({
    id: "channel-b",
    workspaceId: "workspace-b",
    telegramChatId: "@tenant_b_channel",
    title: "Tenant B Channel",
    name: "B channel",
    username: "tenant_b_channel",
    botPermissions: { canPostMessages: true },
    isDefault: true,
  });
  store.addCredential({
    id: "credential-a",
    token: TOKEN_A,
    userId: "user-a",
    workspaceId: "workspace-a",
  });
  store.addCredential({
    id: "credential-b",
    token: TOKEN_B,
    userId: "user-b",
    workspaceId: "workspace-b",
  });
  return {
    store,
    principalA: store.authenticate(TOKEN_A),
    principalB: store.authenticate(TOKEN_B),
  };
}

async function mcpClientFor(t, server) {
  const client = new Client({ name: "saas-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(() => client.close());
  t.after(() => server.close());
  return client;
}

function telegramMock(messageId = 101) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        ok: true,
        result: {
          message_id: messageId,
          date: 1_700_000_000,
          chat: {
            id: body.chat_id === "@tenant_a_channel" ? -1001 : -1002,
            title: body.chat_id,
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}

class MockHttpResponse extends Writable {
  constructor() {
    super();
    this.statusCode = null;
    this.headers = new Map();
    this.chunks = [];
    this.headersSent = false;
  }

  setHeader(name, value) {
    this.headers.set(name.toLowerCase(), value);
  }

  getHeader(name) {
    return this.headers.get(name.toLowerCase());
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    this.headersSent = true;
    return this;
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  body() {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

async function dispatchHttp(app, { method, url, headers = {} }) {
  const response = new MockHttpResponse();
  const finished = once(response, "finish");
  app.emit("request", { method, url, headers: { host: "local.test", ...headers } }, response);
  await finished;
  return response;
}

test("bearer credentials resolve a trusted workspace principal", async () => {
  const { store } = tenantFixture();
  assert.equal(await authenticateMcpRequest(undefined, store), null);
  assert.equal(await authenticateMcpRequest("Bearer wrong-token-value-0123456789", store), null);
  assert.deepEqual(await authenticateMcpRequest(`Bearer ${TOKEN_A}`, store), {
    authSubjectId: "credential-a",
    credentialId: "credential-a",
    userId: "user-a",
    workspaceId: "workspace-a",
    automationGrantId: null,
    allowDuplicatePublish: false,
    scopes: null,
  });
});

test("list, preview, and publish are isolated by authenticated workspace", async (t) => {
  const { store, principalA, principalB } = tenantFixture();
  const env = { TELEGRAM_BOT_TOKEN: "shared-platform-bot" };
  const serverA = createDigestServer(env, {
    store,
    principal: principalA,
    telegramOptions: { fetchImpl: telegramMock(111) },
  });
  const clientA = await mcpClientFor(t, serverA);
  const tools = await clientA.listTools();
  const publishTool = tools.tools.find((tool) => tool.name === "publish_digest");
  assert.deepEqual(publishTool._meta.securitySchemes, [
    { type: "oauth2", scopes: ["publications.write"] },
  ]);
  // The stock MCP 1.x client schema strips extension fields after transport;
  // inspect the server's wire response to verify ChatGPT sees the top-level field.
  const wireTools = await serverA.server._requestHandlers.get("tools/list")({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  });
  assert.deepEqual(wireTools.tools.find((tool) => tool.name === "publish_digest").securitySchemes, [
    { type: "oauth2", scopes: ["publications.write"] },
  ]);
  const listedA = await clientA.callTool({ name: "list_channels", arguments: {} });
  assert.deepEqual(listedA.structuredContent.channels.map((channel) => channel.id), [
    "channel-a",
  ]);

  const rejectedForeignChannel = await clientA.callTool({
    name: "preview_digest",
    arguments: { markdown: "Tenant isolation test", channelIds: ["channel-b"] },
  });
  assert.equal(rejectedForeignChannel.isError, true);
  assert.match(rejectedForeignChannel.content[0].text, /not available in this workspace/);

  const previewA = await clientA.callTool({
    name: "preview_digest",
    arguments: { markdown: "Tenant A exact preview", channelIds: ["channel-a"] },
  });
  assert.equal(previewA.structuredContent.previewStatus, "prepared");
  assert.deepEqual(previewA.structuredContent.channelIds, ["channel-a"]);

  const serverB = createDigestServer(env, {
    store,
    principal: principalB,
    telegramOptions: { fetchImpl: telegramMock(112) },
  });
  const clientB = await mcpClientFor(t, serverB);
  const stolenPreview = await clientB.callTool({
    name: "publish_digest",
    arguments: {
      previewId: previewA.structuredContent.previewId,
      previewSha256: previewA.structuredContent.sha256,
    },
  });
  assert.equal(stolenPreview.isError, true);
  assert.match(stolenPreview.content[0].text, /does not exist in this workspace/);

  const publishedA = await clientA.callTool({
    name: "publish_digest",
    arguments: {
      previewId: previewA.structuredContent.previewId,
      previewSha256: previewA.structuredContent.sha256,
    },
  });
  assert.equal(publishedA.structuredContent.previewStatus, "published");
  assert.equal(store.listAuditEvents("workspace-a").length, 1);
  assert.equal(store.listAuditEvents("workspace-b").length, 0);

  const replay = await clientA.callTool({
    name: "publish_digest",
    arguments: {
      previewId: previewA.structuredContent.previewId,
      previewSha256: previewA.structuredContent.sha256,
    },
  });
  assert.equal(replay.isError, true);
  assert.match(replay.content[0].text, /already published/);
});

test("scheduled mode requires a credential-bound grant and enforces daily quota", async (t) => {
  const { store, principalA } = tenantFixture();
  store.addAutomationGrant({
    id: "grant-a",
    workspaceId: "workspace-a",
    allowedChannelIds: ["channel-a"],
    autonomousPublish: true,
    maxPostsPerRun: 1,
    maxPostsPerDay: 1,
  });
  store.addCredential({
    id: "automation-credential-a",
    token: "automation-token-a-0123456789abcdef",
    userId: "user-a",
    workspaceId: "workspace-a",
    automationGrantId: "grant-a",
  });
  const automationPrincipal = store.authenticate("automation-token-a-0123456789abcdef");
  const env = { TELEGRAM_BOT_TOKEN: "shared-platform-bot" };

  const ordinaryServer = createDigestServer(env, { store, principal: principalA });
  const ordinaryClient = await mcpClientFor(t, ordinaryServer);
  const ordinaryPreview = await ordinaryClient.callTool({
    name: "preview_digest",
    arguments: { markdown: "No grant scheduled test", channelIds: ["channel-a"] },
  });
  const denied = await ordinaryClient.callTool({
    name: "publish_digest",
    arguments: {
      previewId: ordinaryPreview.structuredContent.previewId,
      previewSha256: ordinaryPreview.structuredContent.sha256,
      publicationMode: "scheduled",
    },
  });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /automation-bound credential/);

  const automationServer = createDigestServer(env, {
    store,
    principal: automationPrincipal,
    telegramOptions: { fetchImpl: telegramMock(121) },
  });
  const automationClient = await mcpClientFor(t, automationServer);
  const firstPreview = await automationClient.callTool({
    name: "preview_digest",
    arguments: { markdown: "Scheduled grant test one", channelIds: ["channel-a"] },
  });
  const firstPublish = await automationClient.callTool({
    name: "publish_digest",
    arguments: {
      previewId: firstPreview.structuredContent.previewId,
      previewSha256: firstPreview.structuredContent.sha256,
      publicationMode: "scheduled",
    },
  });
  assert.equal(firstPublish.structuredContent.status, "complete");

  const secondPreview = await automationClient.callTool({
    name: "preview_digest",
    arguments: { markdown: "Scheduled grant test two", channelIds: ["channel-a"] },
  });
  const overQuota = await automationClient.callTool({
    name: "publish_digest",
    arguments: {
      previewId: secondPreview.structuredContent.previewId,
      previewSha256: secondPreview.structuredContent.sha256,
      publicationMode: "scheduled",
    },
  });
  assert.equal(overQuota.isError, true);
  assert.match(overQuota.content[0].text, /maxPostsPerDay/);
  const audit = store.listAuditEvents("workspace-a");
  assert.equal(audit.length, 3);
  const publishedAudit = audit.find((event) => event.result === "published");
  assert.equal(publishedAudit.automationGrantId, "grant-a");
  assert.equal(publishedAudit.publicationMode, "scheduled");
  assert.equal(
    audit.filter((event) => event.result === "denied").length,
    2,
  );
});

test("server-side previews expire and cannot be published", async (t) => {
  let now = new Date("2026-08-28T00:00:00.000Z");
  const { store, principalA } = tenantFixture({ clock: () => now });
  const server = createDigestServer(
    { TELEGRAM_BOT_TOKEN: "shared-platform-bot", PREVIEW_TTL_SECONDS: "60" },
    { store, principal: principalA, telegramOptions: { fetchImpl: telegramMock(131) } },
  );
  const client = await mcpClientFor(t, server);
  const preview = await client.callTool({
    name: "preview_digest",
    arguments: { markdown: "Expiring preview", channelIds: ["channel-a"] },
  });
  now = new Date("2026-08-28T00:01:01.000Z");
  const expired = await client.callTool({
    name: "publish_digest",
    arguments: {
      previewId: preview.structuredContent.previewId,
      previewSha256: preview.structuredContent.sha256,
    },
  });
  assert.equal(expired.isError, true);
  assert.match(expired.content[0].text, /expired/);
});

test("HTTP SaaS endpoint publishes protected-resource metadata and challenges missing bearer auth", async (t) => {
  const { store } = tenantFixture();
  const app = createHttpApp({
    store,
    env: {
      TELEGRAM_BOT_TOKEN: "shared-platform-bot",
      PUBLIC_BASE_URL: "https://publisher.example",
      OAUTH_ISSUER: "https://auth.publisher.example",
    },
  });
  t.after(() => app.close());

  const metadataResponse = await dispatchHttp(app, {
    method: "GET",
    url: "/.well-known/oauth-protected-resource",
  });
  assert.equal(metadataResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(metadataResponse.body()), {
    resource: "https://publisher.example/mcp",
    authorization_servers: ["https://auth.publisher.example"],
    scopes_supported: [
      "channels.read",
      "previews.write",
        "publications.write",
        "automations.manage",
        "onboarding.write",
      ],
    bearer_methods_supported: ["header"],
  });

  const unauthorized = await dispatchHttp(app, { method: "POST", url: "/mcp" });
  assert.equal(unauthorized.statusCode, 401);
  assert.match(
    unauthorized.getHeader("www-authenticate"),
    /^Bearer resource_metadata="https:\/\/publisher\.example\/\.well-known\/oauth-protected-resource", error="invalid_token"/,
  );
});
