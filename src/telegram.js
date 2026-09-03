import { Blob } from "node:buffer";
import { FormData, ProxyAgent, fetch as undiciFetch } from "undici";
import { resolveTelegramChannels } from "./channels.js";

const DEFAULT_TELEGRAM_API_BASE = "https://api.telegram.org";
const proxyAgents = new Map();

function requiredEnv(name, env) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function asBoolean(value) {
  return /^(1|true|yes)$/i.test(value ?? "");
}

function proxyAgent(proxyUrl) {
  if (!proxyUrl) return undefined;

  let parsed;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    throw new Error("TELEGRAM_PROXY_URL must be a valid HTTP(S) proxy URL.");
  }

  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new Error("TELEGRAM_PROXY_URL must use the http or https scheme.");
  }

  if (!proxyAgents.has(proxyUrl)) {
    proxyAgents.set(proxyUrl, new ProxyAgent(proxyUrl));
  }
  return proxyAgents.get(proxyUrl);
}

export function telegramConfig(env = process.env, channelId = null) {
  const botToken = requiredEnv("TELEGRAM_BOT_TOKEN", env);
  const resolvedChannelId = channelId ?? resolveTelegramChannels(undefined, env)[0].id;
  return {
    botToken,
    channelId: resolvedChannelId,
    apiBase: (env.TELEGRAM_API_BASE || DEFAULT_TELEGRAM_API_BASE).replace(/\/$/, ""),
    proxyUrl: env.TELEGRAM_PROXY_URL?.trim() || null,
    disableNotification: asBoolean(env.TELEGRAM_DISABLE_NOTIFICATION),
  };
}

async function telegramRequest(method, body, options = {}) {
  const config = options.config ?? telegramConfig();
  const fetchImpl = options.fetchImpl ?? undiciFetch;
  const dispatcher = options.dispatcher ?? proxyAgent(config.proxyUrl);
  const controller = new AbortController();
  const files = options.files ?? [];
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? (files.length ? 60_000 : 15_000),
  );

  let requestBody;
  let headers;
  if (files.length) {
    requestBody = new FormData();
    for (const [name, value] of Object.entries(body)) {
      if (value === undefined || value === null) continue;
      requestBody.append(name, typeof value === "string" ? value : JSON.stringify(value));
    }
    for (const file of files) {
      requestBody.append(
        file.fieldName,
        new Blob([file.data], { type: file.mimeType }),
        file.filename,
      );
    }
  } else {
    requestBody = JSON.stringify(body);
    headers = { "content-type": "application/json" };
  }

  try {
    const response = await fetchImpl(
      `${config.apiBase}/bot${config.botToken}/${method}`,
      {
        method: "POST",
        ...(headers ? { headers } : {}),
        body: requestBody,
        signal: controller.signal,
        ...(dispatcher ? { dispatcher } : {}),
      },
    );

    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      const detail = payload?.description || `${response.status} ${response.statusText}`;
      throw new Error(`Telegram rejected the publication: ${detail}`);
    }

    return { result: payload.result, config };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Telegram publication timed out.");
    }
    if (error instanceof TypeError) {
      const causeCode = error.cause?.code;
      const causeMessage = error.cause?.message;
      const detail = [causeCode, causeMessage].filter(Boolean).join(": ");
      throw new Error(
        detail
          ? `Telegram network request failed: ${detail}`
          : `Telegram network request failed: ${error.message}`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function callTelegramBotApi(method, body = {}, options = {}) {
  const config =
    options.config ?? telegramConfig(options.env ?? process.env, options.channelId ?? "0");
  const { result } = await telegramRequest(method, body, { ...options, config });
  return result;
}

function publicationResult(message, config) {
  const username = message.chat?.username;
  return {
    messageId: message.message_id,
    chatId: String(message.chat?.id ?? config.channelId),
    channelTitle: message.chat?.title ?? username ?? config.channelId,
    publishedAt: new Date(message.date * 1000).toISOString(),
    url: username ? `https://t.me/${username}/${message.message_id}` : null,
  };
}

export async function sendTelegramMessage(html, options = {}) {
  const config = options.config ?? telegramConfig();
  const { result } = await telegramRequest(
    "sendMessage",
    {
      chat_id: config.channelId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      disable_notification: config.disableNotification,
    },
    { ...options, config },
  );
  return publicationResult(result, config);
}

export async function sendTelegramPhoto(html, image, options = {}) {
  const config = options.config ?? telegramConfig();
  const localFile = options.localMedia?.get(image.source);
  const { result } = await telegramRequest(
    "sendPhoto",
    {
      chat_id: config.channelId,
      ...(localFile ? {} : { photo: image.source }),
      caption: html,
      parse_mode: "HTML",
      has_spoiler: image.spoiler,
      show_caption_above_media: options.showCaptionAboveMedia === true,
      disable_notification: config.disableNotification,
    },
    {
      ...options,
      config,
      ...(localFile
        ? {
            files: [
              {
                fieldName: "photo",
                ...localFile,
              },
            ],
          }
        : {}),
    },
  );
  return publicationResult(result, config);
}

export async function sendTelegramRichMessage(richMarkdown, images = [], options = {}) {
  const config = options.config ?? telegramConfig();
  const richMessage = { markdown: richMarkdown };
  const files = [];
  if (images.length) {
    richMessage.media = images.map((image, index) => {
      const localFile = options.localMedia?.get(image.source);
      const fieldName = `media_${index}`;
      if (localFile) files.push({ fieldName, ...localFile });
      return {
        id: image.id,
        media: {
          type: "photo",
          media: localFile ? `attach://${fieldName}` : image.source,
          has_spoiler: image.spoiler,
        },
      };
    });
  }

  const { result } = await telegramRequest(
    "sendRichMessage",
    {
      chat_id: config.channelId,
      rich_message: richMessage,
      disable_notification: config.disableNotification,
    },
    { ...options, config, files },
  );
  return publicationResult(result, config);
}

export function sendTelegramPublication(formatted, options = {}) {
  if (formatted.publicationFormat === "rich") {
    return sendTelegramRichMessage(formatted.richMarkdown, formatted.images, options);
  }
  if (formatted.images.length === 1) {
    return sendTelegramPhoto(formatted.html, formatted.images[0], {
      ...options,
      showCaptionAboveMedia: formatted.showCaptionAboveMedia,
    });
  }
  return sendTelegramMessage(formatted.html, options);
}
