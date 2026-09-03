import { callTelegramBotApi } from "../src/telegram.js";

const publicBase = process.env.PUBLIC_BASE_URL?.trim()?.replace(/\/$/, "");
const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
if (!publicBase?.startsWith("https://")) throw new Error("PUBLIC_BASE_URL must use HTTPS.");
if (!secret || secret.length < 32) throw new Error("TELEGRAM_WEBHOOK_SECRET is not configured.");

const webhookUrl = `${publicBase}/api/telegram/webhook`;
await callTelegramBotApi("setWebhook", {
  url: webhookUrl,
  secret_token: secret,
  allowed_updates: ["message"],
  drop_pending_updates: false,
});
const info = await callTelegramBotApi("getWebhookInfo");
if (info.url !== webhookUrl) throw new Error("Telegram webhook URL did not persist.");
if (info.has_custom_certificate === true) throw new Error("Unexpected custom Telegram certificate.");
console.log(`Telegram webhook configured for ${webhookUrl}.`);
