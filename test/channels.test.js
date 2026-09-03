import test from "node:test";
import assert from "node:assert/strict";
import {
  listTelegramChannels,
  resolveTelegramChannels,
  telegramChannelRegistry,
} from "../src/channels.js";

test("keeps TELEGRAM_CHANNEL_ID as a single-channel fallback", () => {
  const env = {
    TELEGRAM_CHANNEL_ID: "@alterego_news",
    TELEGRAM_DEFAULT_CHANNEL: "Alterego",
  };
  assert.deepEqual(listTelegramChannels(env), [
    { name: "Alterego", isDefault: true },
  ]);
  assert.deepEqual(resolveTelegramChannels(undefined, env), [
    { name: "Alterego", id: "@alterego_news" },
  ]);
});

test("resolves multiple allowlisted names case-insensitively and in requested order", () => {
  const env = {
    TELEGRAM_CHANNELS_JSON:
      '{"Alterego":"@alterego_news","Alterego sub channel":"-100222"}',
    TELEGRAM_DEFAULT_CHANNEL: "Alterego",
  };
  assert.deepEqual(
    resolveTelegramChannels([" alterego SUB   channel ", "ALTEREGO"], env),
    [
      { name: "Alterego sub channel", id: "-100222" },
      { name: "Alterego", id: "@alterego_news" },
    ],
  );
});

test("rejects unknown names, duplicate targets, and an ambiguous default", () => {
  const env = {
    TELEGRAM_CHANNELS_JSON:
      '{"Alterego":"@alterego_news","Alterego sub channel":"-100222"}',
  };
  assert.throws(() => resolveTelegramChannels(undefined, env), /No default/);
  assert.throws(
    () => resolveTelegramChannels(["Unknown"], env),
    /Available channels: Alterego, Alterego sub channel/,
  );
  assert.throws(
    () => resolveTelegramChannels(["Alterego", "alterego"], env),
    /duplicated/,
  );
});

test("validates registry JSON and prevents duplicate Telegram IDs", () => {
  assert.throws(
    () => telegramChannelRegistry({ TELEGRAM_CHANNELS_JSON: "not-json" }),
    /valid JSON/,
  );
  assert.throws(
    () =>
      telegramChannelRegistry({
        TELEGRAM_CHANNELS_JSON: '{"One":"@same_channel","Two":"@same_channel"}',
      }),
    /configured more than once/,
  );
  assert.throws(
    () =>
      telegramChannelRegistry({
        TELEGRAM_CHANNELS_JSON: '{"One":"https://t.me/channel"}',
      }),
    /@username or numeric chat ID/,
  );
});
