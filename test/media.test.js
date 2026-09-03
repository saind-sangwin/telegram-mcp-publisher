import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Writable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTemporaryMediaStore } from "../src/media.js";
import { createDigestServer } from "../src/server.js";

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

class MockHttpResponse extends Writable {
  constructor() {
    super();
    this.statusCode = null;
    this.headers = {};
    this.chunks = [];
    this.headersSent = false;
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }
}

async function temporaryMediaFixture(t, extraEnv = {}) {
  const storageDir = await mkdtemp(join(tmpdir(), "alterego-media-test-"));
  t.after(() => rm(storageDir, { recursive: true, force: true }));
  const env = {
    MEDIA_PUBLIC_BASE_URL: "https://publisher.example/telegram-media",
    MEDIA_STORAGE_DIR: storageDir,
    MEDIA_TTL_SECONDS: "60",
    ...extraEnv,
  };
  const store = createTemporaryMediaStore(env);
  return { env, store, storageDir };
}

test("uploads validated image bytes under an opaque local reference", async (t) => {
  const { store } = await temporaryMediaFixture(t);
  const uploaded = await store.upload({
    contentBase64: ONE_PIXEL_PNG,
    mimeType: "image/png",
  });
  const filename = store.sourceToFilename(uploaded.source);
  assert.match(uploaded.source, /^mcp-upload:[a-f0-9]{48}\.png$/);
  assert.equal(uploaded.sizeBytes, Buffer.from(ONE_PIXEL_PNG, "base64").length);
  assert.ok(filename);

  const localMedia = await store.readSources([uploaded.source]);
  assert.equal(localMedia.get(uploaded.source).mimeType, "image/png");
  assert.deepEqual(
    localMedia.get(uploaded.source).data,
    Buffer.from(ONE_PIXEL_PNG, "base64"),
  );

  // The old HTTPS path remains readable during a rolling v1.4 -> v1.5 deployment.
  const response = new MockHttpResponse();
  const finished = once(response, "finish");
  const handled = await store.handleHttpRequest(
    { method: "GET" },
    response,
    new URL(`https://publisher.example/telegram-media/${filename}`),
  );
  assert.equal(handled, true);
  await finished;
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "image/png");
  assert.deepEqual(Buffer.concat(response.chunks), Buffer.from(ONE_PIXEL_PNG, "base64"));
});

test("upload_image output can be previewed, published, and is removed afterwards", async (t) => {
  const { env: mediaEnv, store } = await temporaryMediaFixture(t);
  const env = {
    ...mediaEnv,
    TELEGRAM_BOT_TOKEN: "secret-media-cleanup",
    TELEGRAM_CHANNEL_ID: "@test_channel",
  };
  let uploadedPath;
  const server = createDigestServer(env, {
    mediaStore: store,
    telegramOptions: {
      fetchImpl: async (_url, init) => {
        const richMessage = JSON.parse(init.body.get("rich_message"));
        assert.equal(richMessage.media[0].media.media, "attach://media_0");
        const uploadedFile = init.body.get("media_0");
        assert.equal(uploadedFile.type, "image/png");
        assert.deepEqual(
          Buffer.from(await uploadedFile.arrayBuffer()),
          Buffer.from(ONE_PIXEL_PNG, "base64"),
        );
        await access(uploadedPath);
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              message_id: 71,
              date: 1_700_000_000,
              chat: { id: -100444, title: "Test channel", username: "test_channel" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    },
  });
  const client = new Client({ name: "media-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(() => client.close());
  t.after(() => server.close());

  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "upload_image"));
  const upload = await client.callTool({
    name: "upload_image",
    arguments: { contentBase64: ONE_PIXEL_PNG, mimeType: "image/png" },
  });
  const source = upload.structuredContent.source;
  uploadedPath = store.filePath(store.sourceToFilename(source));
  await access(uploadedPath);

  const digestArguments = {
    publicationFormat: "rich",
    markdown: "# Уникальная проверка временного изображения\n\n{{image:cover}}",
    images: [{ id: "cover", source }],
  };
  const preview = await client.callTool({
    name: "preview_digest",
    arguments: digestArguments,
  });
  const published = await client.callTool({
    name: "publish_digest",
    arguments: {
      previewId: preview.structuredContent.previewId,
      previewSha256: preview.structuredContent.sha256,
    },
  });
  assert.equal(published.structuredContent.status, "complete");
  await assert.rejects(access(uploadedPath), { code: "ENOENT" });
});

test("unused uploads are removed by TTL cleanup", async (t) => {
  const { store } = await temporaryMediaFixture(t);
  const uploaded = await store.upload({
    contentBase64: ONE_PIXEL_PNG,
    mimeType: "image/png",
  });
  const path = store.filePath(store.sourceToFilename(uploaded.source));
  const old = new Date(Date.now() - 120_000);
  await utimes(path, old, old);
  assert.equal(await store.cleanupExpired(), 1);
  await assert.rejects(access(path), { code: "ENOENT" });
});

test("rejects a MIME type that does not match the uploaded bytes", async (t) => {
  const { store } = await temporaryMediaFixture(t);
  await assert.rejects(
    store.upload({ contentBase64: ONE_PIXEL_PNG, mimeType: "image/jpeg" }),
    /does not match image\/jpeg/,
  );
});
