import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  OAuthAuthenticationError,
  extractBearerToken,
  hasScope,
} from "./oauth.js";
import { callTelegramBotApi } from "./telegram.js";

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readJson(req, maxBytes = 65_536) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new ApiError(413, "payload_too_large", "JSON body is too large.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON.");
  }
}

function safeSecretEqual(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function challengeHash(token, pepper) {
  return createHmac("sha256", pepper).update(token).digest("hex");
}

function channelJson(channel) {
  return {
    id: channel.id,
    telegramChatId: channel.telegramChatId,
    title: channel.title,
    name: channel.name,
    username: channel.username,
    status: channel.status,
    botPermissions: channel.botPermissions,
    isDefault: channel.isDefault,
    createdAt: channel.createdAt,
  };
}

function requireString(value, name, { min = 1, max = 200 } = {}) {
  if (typeof value !== "string") throw new ApiError(400, "invalid_request", `${name} is required.`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new ApiError(400, "invalid_request", `${name} must contain ${min}-${max} characters.`);
  }
  return normalized;
}

function requireAdmin(principal) {
  if (!["owner", "admin"].includes(principal.role)) {
    throw new ApiError(403, "forbidden", "Workspace owner or admin role is required.");
  }
}

function requireScope(principal, scope) {
  if (!hasScope(principal, scope)) {
    throw new ApiError(403, "insufficient_scope", `OAuth scope ${scope} is required.`);
  }
}

function memberIsAdmin(member) {
  return member?.status === "creator" || member?.status === "administrator";
}

function botCanPost(member) {
  return member?.status === "creator" ||
    (member?.status === "administrator" && member.can_post_messages === true);
}

function telegramOptions(env, options) {
  return {
    env,
    ...(options.telegramFetchImpl ? { fetchImpl: options.telegramFetchImpl } : {}),
  };
}

export function createOnboardingApi({ env, store, authenticator, ...options }) {
  const pepper = env.ONBOARDING_TOKEN_PEPPER?.trim();
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!pepper || pepper.length < 32) {
    throw new Error("ONBOARDING_TOKEN_PEPPER must contain at least 32 characters.");
  }
  if (!webhookSecret || webhookSecret.length < 32) {
    throw new Error("TELEGRAM_WEBHOOK_SECRET must contain at least 32 characters.");
  }

  let botIdentityPromise;
  const getBotIdentity = () => {
    botIdentityPromise ??= callTelegramBotApi("getMe", {}, telegramOptions(env, options)).catch(
      (error) => {
        botIdentityPromise = null;
        throw error;
      },
    );
    return botIdentityPromise;
  };

  async function verifiedToken(req) {
    const token = extractBearerToken(req.headers.authorization);
    if (!token || typeof authenticator.verify !== "function") {
      throw new ApiError(401, "unauthorized", "A valid OAuth access token is required.");
    }
    try {
      return await authenticator.verify(token);
    } catch (error) {
      if (error instanceof OAuthAuthenticationError) {
        throw new ApiError(401, "unauthorized", "A valid OAuth access token is required.");
      }
      throw error;
    }
  }

  async function principal(req) {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) throw new ApiError(401, "unauthorized", "A valid OAuth access token is required.");
    try {
      return await authenticator.authenticate(token);
    } catch (error) {
      if (error instanceof OAuthAuthenticationError) {
        throw new ApiError(401, "unauthorized", "A valid linked OAuth access token is required.");
      }
      throw error;
    }
  }

  async function handleWebhook(req, res) {
    if (!safeSecretEqual(req.headers["x-telegram-bot-api-secret-token"], webhookSecret)) {
      throw new ApiError(401, "invalid_webhook_secret", "Invalid Telegram webhook secret.");
    }
    const update = await readJson(req, 256_000);
    if (!Number.isSafeInteger(update.update_id)) {
      throw new ApiError(400, "invalid_update", "Telegram update_id is required.");
    }
    if (!(await store.claimTelegramWebhookUpdate(update.update_id))) {
      return json(res, 200, { ok: true, duplicate: true });
    }
    const message = update.message;
    const match = message?.chat?.type === "private" && typeof message.text === "string"
      ? message.text.match(/^\/start(?:@\w+)?\s+connect_([A-Za-z0-9_-]{43})$/)
      : null;
    if (!match || !message.from?.id) return json(res, 200, { ok: true, ignored: true });
    const linked = await store.linkTelegramChallenge({
      tokenHash: challengeHash(match[1], pepper),
      telegramUser: message.from,
    });
    if (linked) {
      await callTelegramBotApi(
        "sendMessage",
        {
          chat_id: message.chat.id,
          text: "Telegram account confirmed. Return to the service and finish channel verification.",
        },
        telegramOptions(env, options),
      );
    }
    return json(res, 200, { ok: true, linked: Boolean(linked) });
  }

  async function route(req, res, url) {
    if (req.method === "POST" && url.pathname === "/api/telegram/webhook") {
      return handleWebhook(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/onboarding/bootstrap") {
      const verified = await verifiedToken(req);
      requireScope(verified, "onboarding.write");
      const body = await readJson(req);
      const workspaceName = requireString(body.workspaceName, "workspaceName", { min: 2, max: 100 });
      const email = verified.claims.email_verified === true && typeof verified.claims.email === "string"
        ? verified.claims.email.trim().toLowerCase()
        : null;
      const profile = await store.bootstrapOAuthSubject({
        issuer: verified.issuer,
        subject: verified.subject,
        email,
        workspaceName,
      });
      if (profile.created) {
        await store.appendAudit({
          workspaceId: profile.workspace.id,
          initiatorUserId: profile.user.id,
          authSubjectId: profile.authSubjectId,
          result: "onboarding_workspace_created",
          metadata: { issuer: verified.issuer },
        });
      }
      return json(res, profile.created ? 201 : 200, profile);
    }

    const current = await principal(req);
    if (req.method === "GET" && url.pathname === "/api/me") {
      const profile = await store.getPrincipalProfile(current);
      if (!profile) throw new ApiError(404, "not_found", "OAuth profile was not found.");
      return json(res, 200, profile);
    }
    if (req.method === "GET" && url.pathname === "/api/channels") {
      requireScope(current, "channels.read");
      const channels = await store.listAdminChannels(current.workspaceId);
      return json(res, 200, { channels: channels.map(channelJson) });
    }
    if (req.method === "POST" && url.pathname === "/api/onboarding/challenges") {
      requireAdmin(current);
      requireScope(current, "onboarding.write");
      const bot = await getBotIdentity();
      if (!bot.username) throw new ApiError(502, "telegram_bot_invalid", "Telegram bot has no username.");
      const token = randomBytes(32).toString("base64url");
      const challenge = await store.createOnboardingChallenge({
        workspaceId: current.workspaceId,
        userId: current.userId,
        tokenHash: challengeHash(token, pepper),
        ttlSeconds: Number(env.ONBOARDING_CHALLENGE_TTL_SECONDS ?? 600),
      });
      return json(res, 201, {
        ...challenge,
        botUsername: bot.username,
        telegramDeepLink: `https://t.me/${bot.username}?start=connect_${token}`,
      });
    }

    const verifyMatch = url.pathname.match(/^\/api\/onboarding\/challenges\/([0-9a-f-]{36})\/verify$/i);
    if (req.method === "POST" && verifyMatch) {
      requireAdmin(current);
      requireScope(current, "onboarding.write");
      const body = await readJson(req);
      const requestedChat = requireString(body.telegramChatId, "telegramChatId", { min: 2, max: 100 });
      const challenge = await store.getOnboardingChallenge(
        current.workspaceId,
        current.userId,
        verifyMatch[1],
      );
      if (!challenge) throw new ApiError(404, "not_found", "Onboarding challenge was not found.");
      if (challenge.status !== "telegram_linked" || !challenge.telegramUserId) {
        throw new ApiError(409, "challenge_not_linked", "Link the Telegram account before channel verification.");
      }
      let bot;
      let chat;
      let botMember;
      let userMember;
      try {
        bot = await getBotIdentity();
        [chat, botMember, userMember] = await Promise.all([
          callTelegramBotApi("getChat", { chat_id: requestedChat }, telegramOptions(env, options)),
          callTelegramBotApi(
            "getChatMember",
            { chat_id: requestedChat, user_id: bot.id },
            telegramOptions(env, options),
          ),
          callTelegramBotApi(
            "getChatMember",
            { chat_id: requestedChat, user_id: challenge.telegramUserId },
            telegramOptions(env, options),
          ),
        ]);
      } catch (error) {
        throw new ApiError(502, "telegram_verification_failed", error.message);
      }
      if (chat.type !== "channel") {
        throw new ApiError(400, "unsupported_chat_type", "Only Telegram channels can be connected.");
      }
      if (!memberIsAdmin(userMember)) {
        throw new ApiError(403, "telegram_user_not_admin", "Linked Telegram user is not a channel administrator.");
      }
      if (!botCanPost(botMember)) {
        throw new ApiError(409, "bot_cannot_post", "Telegram bot must be an administrator with can_post_messages.");
      }
      let channel;
      try {
        channel = await store.finalizeOnboardingChannel({
          workspaceId: current.workspaceId,
          userId: current.userId,
          challengeId: challenge.id,
          telegramChatId: String(chat.id),
          title: chat.title,
          name: typeof body.name === "string" && body.name.trim()
            ? requireString(body.name, "name", { min: 1, max: 100 })
            : chat.title,
          username: chat.username ?? null,
          botPermissions: {
            status: botMember.status,
            canPostMessages: true,
            canEditMessages: botMember.can_edit_messages === true,
            verifiedAt: new Date().toISOString(),
          },
          isDefault: body.isDefault === true,
        });
      } catch (error) {
        throw new ApiError(409, "channel_claim_conflict", error.message);
      }
      await store.appendAudit({
        workspaceId: current.workspaceId,
        initiatorUserId: current.userId,
        authSubjectId: current.authSubjectId,
        channelId: channel.id,
        telegramChatId: channel.telegramChatId,
        result: "telegram_channel_connected",
        metadata: { telegramUserId: challenge.telegramUserId },
      });
      return json(res, 201, { channel: channelJson(channel) });
    }

    const disableMatch = url.pathname.match(/^\/api\/channels\/([0-9a-f-]{36})\/disable$/i);
    if (req.method === "POST" && disableMatch) {
      requireAdmin(current);
      requireScope(current, "onboarding.write");
      const channel = await store.disableChannel(current.workspaceId, disableMatch[1]);
      if (!channel) throw new ApiError(404, "not_found", "Channel was not found in this workspace.");
      await store.appendAudit({
        workspaceId: current.workspaceId,
        initiatorUserId: current.userId,
        authSubjectId: current.authSubjectId,
        channelId: channel.id,
        telegramChatId: channel.telegramChatId,
        result: "telegram_channel_disabled",
      });
      return json(res, 200, { channel: channelJson(channel) });
    }

    if (req.method === "GET" && url.pathname === "/api/automation-grants") {
      requireAdmin(current);
      requireScope(current, "automations.manage");
      return json(res, 200, { grants: await store.listAutomationGrants(current.workspaceId) });
    }
    if (req.method === "POST" && url.pathname === "/api/automation-grants") {
      requireAdmin(current);
      requireScope(current, "automations.manage");
      const body = await readJson(req);
      if (!Array.isArray(body.channelIds) || !body.channelIds.length || body.channelIds.length > 10) {
        throw new ApiError(400, "invalid_request", "channelIds must contain 1-10 channels.");
      }
      const maxPostsPerRun = Number(body.maxPostsPerRun);
      const maxPostsPerDay = Number(body.maxPostsPerDay);
      if (!Number.isInteger(maxPostsPerRun) || maxPostsPerRun < 1 || maxPostsPerRun > 50) {
        throw new ApiError(400, "invalid_request", "maxPostsPerRun must be an integer from 1 to 50.");
      }
      if (!Number.isInteger(maxPostsPerDay) || maxPostsPerDay < maxPostsPerRun || maxPostsPerDay > 500) {
        throw new ApiError(400, "invalid_request", "maxPostsPerDay must be between maxPostsPerRun and 500.");
      }
      let grant;
      try {
        const created = await store.addAutomationGrant({
          workspaceId: current.workspaceId,
          allowedChannelIds: [...new Set(body.channelIds)],
          autonomousPublish: body.autonomousPublish === true,
          maxPostsPerRun,
          maxPostsPerDay,
          bindPrincipal: body.bindCurrentSubject === true ? current : null,
        });
        grant = (await store.listAutomationGrants(current.workspaceId)).find(
          (candidate) => candidate.id === created.id,
        );
      } catch (error) {
        throw new ApiError(409, "grant_policy_conflict", error.message);
      }
      await store.appendAudit({
        workspaceId: current.workspaceId,
        initiatorUserId: current.userId,
        authSubjectId: current.authSubjectId,
        automationGrantId: grant.id,
        result: "automation_grant_created",
        metadata: { boundCurrentSubject: body.bindCurrentSubject === true },
      });
      return json(res, 201, { grant });
    }

    const bindMatch = url.pathname.match(/^\/api\/automation-grants\/([0-9a-f-]{36})\/bind-current-subject$/i);
    if (req.method === "POST" && bindMatch) {
      requireAdmin(current);
      requireScope(current, "automations.manage");
      try {
        const binding = await store.bindAutomationGrantToSubject(current, bindMatch[1]);
        return json(res, 200, { binding });
      } catch (error) {
        throw new ApiError(409, "grant_binding_conflict", error.message);
      }
    }

    const revokeMatch = url.pathname.match(/^\/api\/automation-grants\/([0-9a-f-]{36})\/revoke$/i);
    if (req.method === "POST" && revokeMatch) {
      requireAdmin(current);
      requireScope(current, "automations.manage");
      try {
        const grant = await store.revokeAutomationGrant(current.workspaceId, revokeMatch[1]);
        await store.appendAudit({
          workspaceId: current.workspaceId,
          initiatorUserId: current.userId,
          authSubjectId: current.authSubjectId,
          automationGrantId: grant.id,
          result: "automation_grant_revoked",
        });
        return json(res, 200, { grant });
      } catch (error) {
        throw new ApiError(404, "not_found", error.message);
      }
    }

    if (req.method === "GET" && url.pathname === "/api/audit") {
      requireAdmin(current);
      requireScope(current, "automations.manage");
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100), 1), 500);
      const events = await store.listAuditEvents(current.workspaceId);
      return json(res, 200, { events: events.slice(-limit).reverse() });
    }

    throw new ApiError(404, "not_found", "API route was not found.");
  }

  return {
    async handle(req, res, url) {
      if (!url.pathname.startsWith("/api/")) return false;
      try {
        await route(req, res, url);
      } catch (error) {
        if (error instanceof ApiError) {
          if (error.status === 401) {
            res.setHeader(
              "WWW-Authenticate",
              `Bearer resource_metadata="${env.PUBLIC_BASE_URL}/.well-known/oauth-protected-resource"`,
            );
          }
          json(res, error.status, { error: error.code, message: error.message });
        } else {
          console.error("Onboarding API request failed", error);
          json(res, 500, { error: "internal_error", message: "Internal server error." });
        }
      }
      return true;
    },
  };
}
