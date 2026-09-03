import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  assertPublicationAuthorization,
  createDigestServer,
  mcpPathFromEnv,
} from "../src/server.js";

test("requires a long MCP access key", () => {
  assert.throws(() => mcpPathFromEnv({}), /MCP_ACCESS_KEY/);
  assert.throws(() => mcpPathFromEnv({ MCP_ACCESS_KEY: "too-short" }), /at least 24/);
  assert.equal(
    mcpPathFromEnv({ MCP_ACCESS_KEY: "0123456789abcdef0123456789abcdef" }),
    "/mcp/0123456789abcdef0123456789abcdef",
  );
});

test("scheduled publication requires an explicit server opt-in", () => {
  assert.doesNotThrow(() =>
    assertPublicationAuthorization(
      { publicationMode: "interactive", allowDuplicate: false },
      {},
    ),
  );

  assert.throws(
    () =>
      assertPublicationAuthorization(
        { publicationMode: "scheduled", allowDuplicate: false },
        {},
      ),
    /ALLOW_SCHEDULED_PUBLISH/,
  );

  assert.doesNotThrow(() =>
    assertPublicationAuthorization(
      { publicationMode: "scheduled", allowDuplicate: false },
      { ALLOW_SCHEDULED_PUBLISH: "true" },
    ),
  );

  assert.throws(
    () =>
      assertPublicationAuthorization(
        { publicationMode: "scheduled", allowDuplicate: true },
        { ALLOW_SCHEDULED_PUBLISH: "true" },
      ),
    /allowDuplicate=true/,
  );
});

test("MCP preview accepts a rich message with a bound image", async () => {
  const server = createDigestServer({ TELEGRAM_CHANNEL_ID: "@test_channel" });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "preview_digest"));
    assert.ok(tools.tools.some((tool) => tool.name === "list_channels"));

    const result = await client.callTool({
      name: "preview_digest",
      arguments: {
        publicationFormat: "rich",
        markdown: "# Заголовок\n\n{{image:cover}}",
        images: [{ id: "cover", source: "https://cdn.example/cover.jpg" }],
      },
    });

    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.publicationFormat, "rich");
    assert.deepEqual(result.structuredContent.channels, ["default"]);
    assert.equal(result.structuredContent.characterLimit, 32768);
    assert.match(result.structuredContent.telegramRichMarkdown, /tg:\/\/photo\?id=cover/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP previews and publishes one exact digest to multiple allowlisted channels", async () => {
  const env = {
    TELEGRAM_BOT_TOKEN: "secret",
    TELEGRAM_CHANNELS_JSON:
      '{"Alterego":"@alterego_news","Alterego sub channel":"-100222"}',
    TELEGRAM_DEFAULT_CHANNEL: "Alterego",
  };
  const requests = [];
  const server = createDigestServer(env, {
    telegramOptions: {
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body);
        requests.push({ url, body });
        const isMain = body.chat_id === "@alterego_news";
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              message_id: isMain ? 51 : 52,
              date: 1_700_000_000,
              chat: isMain
                ? { id: -100111, title: "Alterego", username: "alterego_news" }
                : { id: -100222, title: "Alterego sub channel" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    },
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const argumentsWithoutHash = {
    markdown: "Уникальная проверка нескольких каналов",
    channels: ["Alterego", "Alterego sub channel"],
  };
  try {
    const listed = await client.callTool({ name: "list_channels", arguments: {} });
    assert.deepEqual(
      listed.structuredContent.channels.map(({ name, isDefault }) => ({ name, isDefault })),
      [
        { name: "Alterego", isDefault: true },
        { name: "Alterego sub channel", isDefault: false },
      ],
    );
    assert.ok(listed.structuredContent.channels.every((channel) => channel.id));

    const preview = await client.callTool({
      name: "preview_digest",
      arguments: argumentsWithoutHash,
    });
    assert.deepEqual(preview.structuredContent.channels, [
      "Alterego",
      "Alterego sub channel",
    ]);

    const published = await client.callTool({
      name: "publish_digest",
      arguments: {
        previewId: preview.structuredContent.previewId,
        previewSha256: preview.structuredContent.sha256,
      },
    });
    assert.equal(published.structuredContent.status, "complete");
    assert.equal(published.structuredContent.publishedCount, 2);
    assert.equal(requests.length, 2);
    assert.deepEqual(
      requests.map((request) => request.body.chat_id),
      ["@alterego_news", "-100222"],
    );

    const duplicate = await client.callTool({
      name: "publish_digest",
      arguments: {
        previewId: preview.structuredContent.previewId,
        previewSha256: preview.structuredContent.sha256,
      },
    });
    assert.equal(duplicate.isError, true);
    assert.match(duplicate.content[0].text, /already published/);
    assert.equal(requests.length, 2);
  } finally {
    await client.close();
    await server.close();
  }
});

test("multi-channel publication reports partial success without losing results", async () => {
  const env = {
    TELEGRAM_BOT_TOKEN: "secret-partial",
    TELEGRAM_CHANNELS_JSON:
      '{"Partial main":"@partial_main","Partial sub":"-100333"}',
    TELEGRAM_DEFAULT_CHANNEL: "Partial main",
  };
  const server = createDigestServer(env, {
    telegramOptions: {
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        if (body.chat_id === "-100333") {
          return new Response(
            JSON.stringify({ ok: false, description: "Forbidden: bot is not an administrator" }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              message_id: 61,
              date: 1_700_000_000,
              chat: { id: -100332, title: "Partial main", username: "partial_main" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    },
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const baseArguments = {
    markdown: "Уникальная частичная публикация",
    channels: ["Partial main", "Partial sub"],
  };
  try {
    const preview = await client.callTool({
      name: "preview_digest",
      arguments: baseArguments,
    });
    const result = await client.callTool({
      name: "publish_digest",
      arguments: {
        previewId: preview.structuredContent.previewId,
        previewSha256: preview.structuredContent.sha256,
      },
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.status, "partial");
    assert.equal(result.structuredContent.publishedCount, 1);
    assert.equal(result.structuredContent.failedCount, 1);
    assert.match(result.structuredContent.publications[1].error, /not an administrator/);
  } finally {
    await client.close();
    await server.close();
  }
});
