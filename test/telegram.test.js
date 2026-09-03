import test from "node:test";
import assert from "node:assert/strict";
import {
  sendTelegramMessage,
  sendTelegramPhoto,
  sendTelegramRichMessage,
  telegramConfig,
} from "../src/telegram.js";

test("requires a bot token and configured channel registry", () => {
  assert.throws(() => telegramConfig({}), /TELEGRAM_BOT_TOKEN/);
  assert.throws(
    () => telegramConfig({ TELEGRAM_BOT_TOKEN: "token" }),
    /TELEGRAM_CHANNEL_ID/,
  );
});

test("reads the optional Telegram-only proxy URL", () => {
  const config = telegramConfig({
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_CHANNEL_ID: "@channel",
    TELEGRAM_PROXY_URL: "http://vless-proxy:1080",
  });

  assert.equal(config.proxyUrl, "http://vless-proxy:1080");
});

test("sends Telegram HTML with previews disabled", async () => {
  let request;
  const result = await sendTelegramMessage("<b>Digest</b>", {
    config: {
      botToken: "secret",
      channelId: "@alterego_news",
      apiBase: "https://telegram.invalid",
      disableNotification: false,
    },
    fetchImpl: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: 42,
            date: 1_700_000_000,
            chat: { id: -1001, title: "Alterego", username: "alterego_news" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  assert.equal(request.url, "https://telegram.invalid/botsecret/sendMessage");
  assert.equal(request.body.chat_id, "@alterego_news");
  assert.equal(request.body.parse_mode, "HTML");
  assert.equal(request.body.link_preview_options.is_disabled, true);
  assert.equal(result.url, "https://t.me/alterego_news/42");
});

test("surfaces Telegram API errors", async () => {
  await assert.rejects(
    () =>
      sendTelegramMessage("digest", {
        config: {
          botToken: "secret",
          channelId: "@channel",
          apiBase: "https://telegram.invalid",
          disableNotification: false,
        },
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: "Forbidden" }), {
            status: 403,
            headers: { "content-type": "application/json" },
          }),
      }),
    /Forbidden/,
  );
});

test("surfaces safe network error details", async () => {
  const networkError = new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect ETIMEDOUT 149.154.166.110:443"), {
      code: "ETIMEDOUT",
    }),
  });

  await assert.rejects(
    () =>
      sendTelegramMessage("digest", {
        config: {
          botToken: "secret-token-not-for-error-output",
          channelId: "@channel",
          apiBase: "https://api.telegram.org",
          disableNotification: false,
        },
        fetchImpl: async () => {
          throw networkError;
        },
      }),
    (error) => {
      assert.match(error.message, /ETIMEDOUT/);
      assert.doesNotMatch(error.message, /secret-token/);
      return true;
    },
  );
});

test("rejects unsupported proxy schemes before publication", async () => {
  await assert.rejects(
    () =>
      sendTelegramMessage("digest", {
        config: {
          botToken: "secret",
          channelId: "@channel",
          apiBase: "https://api.telegram.org",
          proxyUrl: "socks5://proxy:1080",
          disableNotification: false,
        },
      }),
    /must use the http or https scheme/,
  );
});

function successfulTelegramResponse(messageId = 42) {
  return new Response(
    JSON.stringify({
      ok: true,
      result: {
        message_id: messageId,
        date: 1_700_000_000,
        chat: { id: -1001, title: "Alterego", username: "alterego_news" },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("sends a classic cover through sendPhoto", async () => {
  let request;
  await sendTelegramPhoto(
    "<b>Digest</b>",
    { source: "https://cdn.example/cover.jpg", spoiler: true },
    {
      config: {
        botToken: "secret",
        channelId: "@alterego_news",
        apiBase: "https://telegram.invalid",
        disableNotification: false,
      },
      showCaptionAboveMedia: true,
      fetchImpl: async (url, init) => {
        request = { url, body: JSON.parse(init.body) };
        return successfulTelegramResponse();
      },
    },
  );

  assert.equal(request.url, "https://telegram.invalid/botsecret/sendPhoto");
  assert.equal(request.body.photo, "https://cdn.example/cover.jpg");
  assert.equal(request.body.caption, "<b>Digest</b>");
  assert.equal(request.body.parse_mode, "HTML");
  assert.equal(request.body.has_spoiler, true);
  assert.equal(request.body.show_caption_above_media, true);
});

test("sends inline images through sendRichMessage", async () => {
  let request;
  await sendTelegramRichMessage(
    "# Digest\n\n![](tg://photo?id=cover)",
    [
      {
        id: "cover",
        source: "https://cdn.example/cover.jpg",
        spoiler: false,
      },
    ],
    {
      config: {
        botToken: "secret",
        channelId: "@alterego_news",
        apiBase: "https://telegram.invalid",
        disableNotification: true,
      },
      fetchImpl: async (url, init) => {
        request = { url, body: JSON.parse(init.body) };
        return successfulTelegramResponse(43);
      },
    },
  );

  assert.equal(request.url, "https://telegram.invalid/botsecret/sendRichMessage");
  assert.equal(request.body.rich_message.markdown, "# Digest\n\n![](tg://photo?id=cover)");
  assert.deepEqual(request.body.rich_message.media, [
    {
      id: "cover",
      media: {
        type: "photo",
        media: "https://cdn.example/cover.jpg",
        has_spoiler: false,
      },
    },
  ]);
  assert.equal(request.body.disable_notification, true);
});

test("uploads a local rich image directly with multipart form data", async () => {
  const imageBytes = Buffer.from("89504e470d0a1a0a", "hex");
  const source = "mcp-upload:0123456789abcdef0123456789abcdef0123456789abcdef.png";
  let request;
  await sendTelegramRichMessage(
    "# Digest\n\n![](tg://photo?id=cover)",
    [{ id: "cover", source, spoiler: false }],
    {
      config: {
        botToken: "secret",
        channelId: "@alterego_news",
        apiBase: "https://telegram.invalid",
        disableNotification: false,
      },
      localMedia: new Map([
        [
          source,
          {
            filename: "cover.png",
            mimeType: "image/png",
            data: imageBytes,
          },
        ],
      ]),
      fetchImpl: async (url, init) => {
        request = { url, init };
        return successfulTelegramResponse(44);
      },
    },
  );

  assert.equal(request.url, "https://telegram.invalid/botsecret/sendRichMessage");
  assert.equal(request.init.headers, undefined);
  const richMessage = JSON.parse(request.init.body.get("rich_message"));
  assert.equal(richMessage.media[0].media.media, "attach://media_0");
  const file = request.init.body.get("media_0");
  assert.equal(file.name, "cover.png");
  assert.equal(file.type, "image/png");
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), imageBytes);
});

test("uploads a local classic cover directly as the photo field", async () => {
  const imageBytes = Buffer.from("ffd8ff", "hex");
  const source = "mcp-upload:abcdef0123456789abcdef0123456789abcdef0123456789.jpg";
  let request;
  await sendTelegramPhoto(
    "<b>Digest</b>",
    { source, spoiler: false },
    {
      config: {
        botToken: "secret",
        channelId: "@alterego_news",
        apiBase: "https://telegram.invalid",
        disableNotification: false,
      },
      localMedia: new Map([
        [
          source,
          {
            filename: "cover.jpg",
            mimeType: "image/jpeg",
            data: imageBytes,
          },
        ],
      ]),
      fetchImpl: async (url, init) => {
        request = { url, init };
        return successfulTelegramResponse(45);
      },
    },
  );

  assert.equal(request.url, "https://telegram.invalid/botsecret/sendPhoto");
  assert.equal(request.init.body.get("photo").name, "cover.jpg");
  assert.equal(request.init.body.get("caption"), "<b>Digest</b>");
});
