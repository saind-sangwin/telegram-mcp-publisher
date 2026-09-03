import { createServer as createHttpServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { runMigrations } from "./db.js";
import { bindPublicationChannels, formatPublication } from "./format.js";
import { createTemporaryMediaStore } from "./media.js";
import {
  authenticateAuthorizationHeader,
  createAuthenticatorFromEnv,
  createOpaqueBearerAuthenticator,
  hasScope,
} from "./oauth.js";
import { createOnboardingApi } from "./onboarding.js";
import { createPostgresSaasStoreFromEnv } from "./postgres-store.js";
import {
  createLegacySaasContext,
  createSaasStoreFromEnv,
} from "./saas-store.js";
import { sendTelegramPublication, telegramConfig } from "./telegram.js";

const VERSION = "4.0.0";
const OAUTH_SCOPES = [
  "channels.read",
  "previews.write",
  "publications.write",
  "automations.manage",
  "onboarding.write",
];

function oauthSecuritySchemes(scopes) {
  return [{ type: "oauth2", scopes }];
}

function oauthToolMeta(scopes) {
  // OpenAI hosts read this compatibility mirror today. The same schemes are
  // declared per tool and remain enforced by the handler, never by metadata alone.
  return { securitySchemes: oauthSecuritySchemes(scopes) };
}

function exposeTopLevelSecuritySchemes(server) {
  // MCP SDK 1.x preserves extension fields only under `_meta`. ChatGPT Apps
  // also discovers OAuth requirements from the top-level tool field, so wrap
  // the SDK's generated tools/list response until the SDK exposes that field.
  const handlers = server.server?._requestHandlers;
  const original = handlers?.get("tools/list");
  if (!original) throw new Error("MCP SDK tools/list handler is unavailable.");
  server.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const listed = await original(request, extra);
    return {
      ...listed,
      tools: listed.tools.map((tool) => ({
        ...tool,
        ...(tool._meta?.securitySchemes
          ? { securitySchemes: tool._meta.securitySchemes }
          : {}),
      })),
    };
  });
}

export function mcpPathFromEnv(env = process.env) {
  const accessKey = env.MCP_ACCESS_KEY?.trim();
  if (!accessKey) throw new Error("MCP_ACCESS_KEY is not configured.");
  if (!/^[A-Za-z0-9_-]{24,}$/.test(accessKey)) {
    throw new Error(
      "MCP_ACCESS_KEY must contain at least 24 letters, digits, underscores, or hyphens.",
    );
  }
  return `/mcp/${accessKey}`;
}

export async function authenticateMcpRequest(authorization, authenticatorOrStore) {
  const authenticator = authenticatorOrStore?.kind
    ? authenticatorOrStore
    : createOpaqueBearerAuthenticator(authenticatorOrStore);
  return authenticateAuthorizationHeader(authorization, authenticator);
}

// Kept for migration-mode callers and direct unit tests. The commercial publish
// flow performs this authorization inside store.beginPublication(), in the same
// transaction that claims the preview and reserves quota/idempotency.
export function assertPublicationAuthorization(
  { publicationMode = "interactive", allowDuplicate = false, channelIds = [] },
  context = process.env,
) {
  if (!context?.store) {
    if (publicationMode !== "scheduled") return;
    if (!/^(1|true|yes)$/i.test(context.ALLOW_SCHEDULED_PUBLISH ?? "")) {
      throw new Error(
        "Scheduled publication is disabled on the server. Set ALLOW_SCHEDULED_PUBLISH=true to enable it.",
      );
    }
    if (allowDuplicate) throw new Error("Scheduled publication cannot use allowDuplicate=true.");
    return;
  }
  const { store, principal } = context;
  if (publicationMode === "scheduled") {
    if (allowDuplicate) throw new Error("Scheduled publication cannot use allowDuplicate=true.");
    return store.authorizeAutomation(principal, channelIds);
  }
  if (allowDuplicate && !principal.allowDuplicatePublish) {
    throw new Error("This credential is not allowed to use the duplicate publication flow.");
  }
}

const imageSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  source: z.string().min(1).max(2048),
  caption: z.string().max(1024).optional(),
  spoiler: z.boolean().optional().default(false),
});

const baseDigestInputSchema = {
  markdown: z.string().min(1).max(40_000),
  publicationFormat: z.enum(["classic", "rich"]).optional().default("classic"),
  images: z.array(imageSchema).max(50).optional().default([]),
  showCaptionAboveMedia: z.boolean().optional().default(false),
};

const previewOutputSchema = {
  previewId: z.string(),
  previewStatus: z.enum(["prepared", "publishing", "published", "expired", "cancelled"]),
  expiresAt: z.string(),
  publicationFormat: z.enum(["classic", "rich"]),
  normalizedMarkdown: z.string(),
  telegramHtml: z.string(),
  telegramRichMarkdown: z.string().nullable(),
  images: z.array(imageSchema),
  channelIds: z.array(z.string()),
  channels: z.array(z.string()),
  sha256: z.string(),
  visibleCharacters: z.number().int(),
  characterLimit: z.number().int(),
  remainingCharacters: z.number().int(),
};

function publicChannel(channel) {
  return {
    id: channel.id,
    name: channel.name,
    title: channel.title,
    username: channel.username,
    status: channel.status,
    botPermissions: channel.botPermissions,
    isDefault: channel.isDefault,
    createdAt: channel.createdAt,
  };
}

function previewResult(formatted, preview, channels) {
  return {
    previewId: preview.id,
    previewStatus: preview.status,
    expiresAt: preview.expiresAt,
    publicationFormat: formatted.publicationFormat,
    normalizedMarkdown: formatted.markdown,
    telegramHtml: formatted.html,
    telegramRichMarkdown: formatted.richMarkdown,
    images: formatted.images,
    channelIds: channels.map((channel) => channel.id),
    channels: channels.map((channel) => channel.name),
    sha256: formatted.sha256,
    visibleCharacters: formatted.visibleCharacters,
    characterLimit: formatted.characterLimit,
    remainingCharacters: formatted.remainingCharacters,
  };
}

async function sendToChannel(formatted, channel, baseConfig, telegramOptions) {
  try {
    const telegram = await sendTelegramPublication(formatted, {
      ...telegramOptions,
      config: { ...baseConfig, channelId: channel.telegramChatId },
    });
    return {
      ...telegram,
      channelId: channel.id,
      channelName: channel.name,
      status: "published",
      error: null,
    };
  } catch (error) {
    return {
      channelId: channel.id,
      channelName: channel.name,
      chatId: channel.telegramChatId,
      status: "failed",
      messageId: null,
      channelTitle: channel.title,
      publishedAt: null,
      url: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function publishAttemptToTelegram(attempt, env, telegramOptions = {}) {
  const publications = [...attempt.duplicatePublications];
  if (attempt.publishChannels.length) {
    const baseConfig = telegramConfig(env, attempt.publishChannels[0].telegramChatId);
    for (const channel of attempt.publishChannels) {
      publications.push(
        await sendToChannel(attempt.preview.formatted, channel, baseConfig, telegramOptions),
      );
    }
  }
  const order = new Map(attempt.channels.map((channel, index) => [channel.id, index]));
  publications.sort((left, right) => order.get(left.channelId) - order.get(right.channelId));
  const publishedCount = publications.filter((item) => item.status === "published").length;
  const duplicatePreventedCount = publications.filter(
    (item) => item.status === "duplicate_prevented",
  ).length;
  const failedCount = publications.filter((item) => item.status === "failed").length;
  return {
    status:
      failedCount === 0
        ? "complete"
        : publishedCount + duplicatePreventedCount
          ? "partial"
          : "failed",
    publicationFormat: attempt.preview.formatted.publicationFormat,
    sha256: attempt.preview.formatted.sha256,
    channelIds: attempt.channels.map((channel) => channel.id),
    channels: attempt.channels.map((channel) => channel.name),
    publishedCount,
    duplicatePreventedCount,
    failedCount,
    publications,
  };
}

function resourceMetadataUrl(env) {
  const base = env.PUBLIC_BASE_URL?.trim()?.replace(/\/$/, "") || "https://publisher.invalid";
  return `${base}/.well-known/oauth-protected-resource`;
}

function withRequiredScope(principal, scope, env, handler) {
  return async (args) => {
    if (hasScope(principal, scope)) return handler(args);
    const challenge =
      `Bearer resource_metadata="${resourceMetadataUrl(env)}", ` +
      `error="insufficient_scope", error_description="Required scope: ${scope}", ` +
      `scope="${scope}"`;
    return {
      isError: true,
      content: [{ type: "text", text: `Authentication scope ${scope} is required.` }],
      _meta: { "mcp/www_authenticate": [challenge] },
    };
  };
}

function digestContext(env, options) {
  if (options.store && options.principal) {
    return { store: options.store, principal: options.principal, legacy: false };
  }
  const legacy = createLegacySaasContext(env);
  return { ...legacy, legacy: true };
}

export function createDigestServer(env = process.env, options = {}) {
  const mediaStore = options.mediaStore ?? createTemporaryMediaStore(env);
  const { store, principal } = digestContext(env, options);
  const channelDescription =
    "Use internal channel ids returned by list_channels. Names are temporary migration aliases only.";
  const digestInputSchema = {
    ...baseDigestInputSchema,
    channelIds: z.array(z.string().min(1).max(100)).min(1).max(10).optional(),
    channels: z
      .array(z.string().min(1).max(100))
      .min(1)
      .max(10)
      .optional()
      .describe("Deprecated channel-name aliases. Prefer channelIds."),
  };
  const server = new McpServer(
    { name: "telegram-publisher-saas", version: VERSION },
    {
      instructions:
        `Always call list_channels, then preview_digest. Publish only by previewId plus its exact SHA-256. ${channelDescription} Interactive publication requires the user's explicit approval of the exact preview and channel list in the host UI. Scheduled mode is only a call mode: the server independently requires an active automation-bound credential and enforces its channel and quota policy. Never retry ambiguous or partial scheduled results automatically.`,
    },
  );

  server.registerTool(
    "upload_image",
    {
      title: "Upload a temporary publication image",
      description: "Uploads a JPEG, PNG, or WebP to short-lived private storage.",
      inputSchema: {
        contentBase64: z.string().min(4).max(28_000_000),
        mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
      },
      outputSchema: {
        source: z.string().regex(/^mcp-upload:[a-f0-9]{48}\.(?:jpg|png|webp)$/),
        mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
        sizeBytes: z.number().int().positive(),
        expiresAt: z.string(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
      securitySchemes: oauthSecuritySchemes(["previews.write"]),
      _meta: oauthToolMeta(["previews.write"]),
    },
    withRequiredScope(principal, "previews.write", env, async ({ contentBase64, mimeType }) => {
      const uploaded = await mediaStore.upload({ contentBase64, mimeType });
      return {
        structuredContent: uploaded,
        content: [{ type: "text", text: `Temporary image uploaded: ${uploaded.source}` }],
      };
    }),
  );

  server.registerTool(
    "list_channels",
    {
      title: "List workspace Telegram channels",
      description: "Lists only active Telegram channels owned by the authenticated workspace.",
      inputSchema: {},
      outputSchema: {
        channels: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            title: z.string(),
            username: z.string().nullable(),
            status: z.string(),
            botPermissions: z.object({ canPostMessages: z.boolean() }).passthrough(),
            isDefault: z.boolean(),
            createdAt: z.string(),
          }),
        ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      securitySchemes: oauthSecuritySchemes(["channels.read"]),
      _meta: oauthToolMeta(["channels.read"]),
    },
    withRequiredScope(principal, "channels.read", env, async () => {
      const channels = (await store.listChannels(principal.workspaceId)).map(publicChannel);
      return {
        structuredContent: { channels },
        content: [
          {
            type: "text",
            text: channels
              .map(
                (channel) =>
                  `${channel.name} — id ${channel.id}${channel.isDefault ? " (default)" : ""}`,
              )
              .join("\n"),
          },
        ],
      };
    }),
  );

  server.registerTool(
    "preview_digest",
    {
      title: "Prepare a server-side Telegram preview",
      description: `Creates a tenant-owned preview with TTL and prepared status. ${channelDescription}`,
      inputSchema: digestInputSchema,
      outputSchema: previewOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
      securitySchemes: oauthSecuritySchemes(["previews.write"]),
      _meta: oauthToolMeta(["previews.write"]),
    },
    withRequiredScope(
      principal,
      "previews.write",
      env,
      async ({
        markdown,
        publicationFormat,
        images,
        showCaptionAboveMedia,
        channelIds,
        channels: legacyChannelNames,
      }) => {
        if (channelIds && legacyChannelNames) {
          throw new Error("Pass channelIds only; do not combine it with deprecated channels aliases.");
        }
        const selectedChannels = await store.resolveChannels(
          principal.workspaceId,
          channelIds ?? legacyChannelNames,
        );
        const formatted = bindPublicationChannels(
          formatPublication({ markdown, publicationFormat, images, showCaptionAboveMedia }),
          selectedChannels.map((channel) => ({
            name: channel.name,
            id: channel.telegramChatId,
          })),
        );
        const preview = await store.createPreview({
          workspaceId: principal.workspaceId,
          channelIds: selectedChannels.map((channel) => channel.id),
          hash: formatted.sha256,
          content: formatted.markdown,
          options: {
            publicationFormat: formatted.publicationFormat,
            images: formatted.images,
            showCaptionAboveMedia: formatted.showCaptionAboveMedia,
          },
          formatted,
          ttlSeconds: Number(env.PREVIEW_TTL_SECONDS ?? 900),
        });
        const result = previewResult(formatted, preview, selectedChannels);
        const exactText = result.telegramRichMarkdown ?? result.normalizedMarkdown;
        return {
          structuredContent: result,
          content: [
            {
              type: "text",
              text: `Prepared preview ${preview.id} for ${result.channels.join(", ")} (expires ${preview.expiresAt}, SHA-256 ${result.sha256}):\n\n${exactText}`,
            },
          ],
        };
      },
    ),
  );

  server.registerTool(
    "publish_digest",
    {
      title: "Publish an exact server-side preview to Telegram",
      description:
        "Publishes only stored preview content and targets. Scheduled use requires a server-side AutomationGrant bound to the authenticated subject.",
      inputSchema: {
        previewId: z.string().uuid(),
        previewSha256: z.string().regex(/^[a-f0-9]{64}$/),
        publicationMode: z.enum(["interactive", "scheduled"]).optional().default("interactive"),
        allowDuplicate: z.boolean().optional().default(false),
      },
      outputSchema: {
        status: z.enum(["complete", "partial", "failed"]),
        previewId: z.string(),
        previewStatus: z.enum(["published", "cancelled"]),
        sha256: z.string(),
        publicationFormat: z.enum(["classic", "rich"]),
        channelIds: z.array(z.string()),
        channels: z.array(z.string()),
        publishedCount: z.number().int(),
        duplicatePreventedCount: z.number().int(),
        failedCount: z.number().int(),
        publications: z.array(
          z.object({
            channelId: z.string(),
            channelName: z.string(),
            chatId: z.string(),
            status: z.enum(["published", "duplicate_prevented", "failed"]),
            messageId: z.number().int().nullable(),
            channelTitle: z.string(),
            publishedAt: z.string().nullable(),
            url: z.string().nullable(),
            error: z.string().nullable(),
          }),
        ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: false,
      },
      securitySchemes: oauthSecuritySchemes(["publications.write"]),
      _meta: oauthToolMeta(["publications.write"]),
    },
    withRequiredScope(
      principal,
      "publications.write",
      env,
      async ({ previewId, previewSha256, publicationMode, allowDuplicate }) => {
        let attempt;
        try {
          attempt = await store.beginPublication({
            principal,
            previewId,
            previewSha256,
            publicationMode,
            allowDuplicate,
          });
        } catch (error) {
          await store.recordPublicationDenial?.({
            principal,
            previewId,
            publicationMode,
            error,
          });
          throw error;
        }

        let mediaLease;
        let externalSideEffectStarted = false;
        try {
          if (attempt.publishChannels.length) {
            telegramConfig(env, attempt.publishChannels[0].telegramChatId);
          }
          mediaLease = await mediaStore.acquireSources(
            attempt.preview.formatted.images.map((image) => image.source),
          );
          const localMedia = await mediaStore.readSources(
            attempt.preview.formatted.images.map((image) => image.source),
          );
          externalSideEffectStarted = attempt.publishChannels.length > 0;
          const telegramResult = await publishAttemptToTelegram(attempt, env, {
            ...options.telegramOptions,
            localMedia,
          });
          const completed = await store.completePublicationAttempt(attempt, telegramResult);
          return {
            structuredContent: completed,
            content: [
              {
                type: "text",
                text: `Publication ${completed.status}: ${completed.publishedCount} published, ${completed.duplicatePreventedCount} duplicates prevented, ${completed.failedCount} failed.`,
              },
            ],
          };
        } catch (error) {
          await store.failPublicationAttempt(attempt, error, {
            ambiguous: externalSideEffectStarted,
          });
          throw error;
        } finally {
          if (mediaLease) {
            try {
              await mediaStore.releaseSources(mediaLease, { remove: true });
            } catch (error) {
              console.error("Temporary publication image cleanup failed", error);
            }
          }
        }
      },
    ),
  );

  exposeTopLevelSecuritySchemes(server);
  return server;
}

function absolutePublicBase(env, req) {
  return (env.PUBLIC_BASE_URL?.trim() || `http://${req.headers.host ?? "localhost"}`).replace(
    /\/$/,
    "",
  );
}

function createRuntimeStore(env, options) {
  if (options.store) return options.store;
  if (env.DATABASE_URL?.trim()) return createPostgresSaasStoreFromEnv(env);
  if (env.SAAS_BOOTSTRAP_JSON?.trim()) return createSaasStoreFromEnv(env);
  return null;
}

function validateOAuthDeploymentConfig(env, mcpPath) {
  if (!env.DATABASE_URL?.trim()) return;
  const opaqueBootstrap = /^(1|true|yes)$/i.test(
    env.ALLOW_OPAQUE_BOOTSTRAP_AUTH ?? "",
  );
  if (!env.OAUTH_JWKS_URI?.trim()) {
    if (opaqueBootstrap) return;
    throw new Error(
      "PostgreSQL SaaS mode requires OAUTH_JWKS_URI. Set ALLOW_OPAQUE_BOOTSTRAP_AUTH=true only for a temporary migration deployment.",
    );
  }
  if (!env.PUBLIC_BASE_URL?.trim()) {
    throw new Error("Production OAuth mode requires PUBLIC_BASE_URL.");
  }
  if (!env.OAUTH_ISSUER?.trim()) {
    throw new Error("Production OAuth mode requires OAUTH_ISSUER.");
  }
  if (!env.ONBOARDING_TOKEN_PEPPER?.trim() || env.ONBOARDING_TOKEN_PEPPER.trim().length < 32) {
    throw new Error("PostgreSQL SaaS mode requires ONBOARDING_TOKEN_PEPPER with at least 32 characters.");
  }
  if (!env.TELEGRAM_WEBHOOK_SECRET?.trim() || env.TELEGRAM_WEBHOOK_SECRET.trim().length < 32) {
    throw new Error("PostgreSQL SaaS mode requires TELEGRAM_WEBHOOK_SECRET with at least 32 characters.");
  }
  const allowHttp = /^(1|true|yes)$/i.test(env.OAUTH_ALLOW_INSECURE_HTTP ?? "");
  for (const [name, value] of [
    ["PUBLIC_BASE_URL", env.PUBLIC_BASE_URL],
    ["OAUTH_ISSUER", env.OAUTH_ISSUER],
    ["OAUTH_JWKS_URI", env.OAUTH_JWKS_URI],
  ]) {
    const url = new URL(value);
    if (!allowHttp && url.protocol !== "https:") {
      throw new Error(`${name} must use HTTPS in production OAuth mode.`);
    }
  }
  const canonicalResource = `${env.PUBLIC_BASE_URL.trim().replace(/\/$/, "")}${mcpPath}`;
  if (env.OAUTH_AUDIENCE?.trim() && env.OAUTH_AUDIENCE.trim() !== canonicalResource) {
    throw new Error(`OAUTH_AUDIENCE must equal the canonical MCP resource ${canonicalResource}.`);
  }
}

export function createHttpApp(options = {}) {
  const env = options.env ?? process.env;
  const store = createRuntimeStore(env, options);
  const isSaas = Boolean(store);
  const legacyContext = isSaas ? null : createLegacySaasContext(env);
  const mcpPath = options.mcpPath ?? (isSaas ? "/mcp" : mcpPathFromEnv(env));
  const mediaStore = options.mediaStore ?? createTemporaryMediaStore(env);
  validateOAuthDeploymentConfig(env, mcpPath);
  const canonicalResource = `${(env.PUBLIC_BASE_URL?.trim() || "http://localhost").replace(/\/$/, "")}${mcpPath}`;
  const authenticator = isSaas
    ? options.authenticator ?? createAuthenticatorFromEnv(env, { store, audience: canonicalResource })
    : null;
  const onboardingApi = isSaas && typeof store.bootstrapOAuthSubject === "function"
    ? createOnboardingApi({
        env,
        store,
        authenticator,
        telegramFetchImpl: options.telegramFetchImpl,
      })
    : null;
  mediaStore.startCleanupTimer();

  return createHttpServer(async (req, res) => {
    if (!req.url) return res.writeHead(400).end("Missing URL");
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const publicBase = absolutePublicBase(env, req);
    const metadataUrl = `${publicBase}/.well-known/oauth-protected-resource`;

    if (req.method === "GET" && url.pathname === "/") {
      return res
        .writeHead(200, { "content-type": "application/json; charset=utf-8" })
        .end(JSON.stringify({ name: "telegram-publisher-saas", version: VERSION }));
    }
    if (isSaas && req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
      return res
        .writeHead(200, { "content-type": "application/json; charset=utf-8" })
        .end(
          JSON.stringify({
            resource: `${publicBase}${mcpPath}`,
            authorization_servers: [env.OAUTH_ISSUER?.trim() || publicBase],
            scopes_supported: OAUTH_SCOPES,
            bearer_methods_supported: ["header"],
            ...(env.RESOURCE_DOCUMENTATION_URL
              ? { resource_documentation: env.RESOURCE_DOCUMENTATION_URL }
              : {}),
          }),
        );
    }
    try {
      if (await mediaStore.handleHttpRequest(req, res, url)) return;
    } catch (error) {
      console.error("Temporary media request failed", error);
      if (!res.headersSent) res.writeHead(500).end("Internal server error");
      return;
    }
    if (onboardingApi && (await onboardingApi.handle(req, res, url))) return;
    if (req.method === "OPTIONS" && url.pathname === mcpPath) {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, content-type, mcp-session-id",
        "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
      });
      return res.end();
    }

    const mcpMethods = new Set(["POST", "GET", "DELETE"]);
    if (url.pathname === mcpPath && req.method && mcpMethods.has(req.method)) {
      const principal = isSaas
        ? await authenticateMcpRequest(req.headers.authorization, authenticator)
        : legacyContext.principal;
      if (!principal) {
        res.setHeader(
          "WWW-Authenticate",
          `Bearer resource_metadata="${metadataUrl}", error="invalid_token", error_description="A valid access token is required"`,
        );
        return res
          .writeHead(401, { "content-type": "application/json; charset=utf-8" })
          .end(JSON.stringify({ error: "unauthorized" }));
      }

      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
      const server = createDigestServer(env, {
        store: isSaas ? store : legacyContext.store,
        principal,
        mediaStore,
        telegramOptions: options.telegramOptions,
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (error) {
        console.error("MCP request failed", error);
        if (!res.headersSent) res.writeHead(500).end("Internal server error");
      }
      return;
    }
    res.writeHead(404).end("Not Found");
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const store = process.env.DATABASE_URL ? createPostgresSaasStoreFromEnv() : undefined;
  if (store && /^(1|true|yes)$/i.test(process.env.AUTO_MIGRATE ?? "")) {
    await runMigrations(store.pool);
  }
  const port = Number(process.env.PORT ?? 8787);
  createHttpApp({ store }).listen(port, "0.0.0.0", () => {
    console.log(`Telegram publisher listening on http://0.0.0.0:${port}`);
  });
}
