import { createHash, randomUUID } from "node:crypto";
import { listTelegramChannels, resolveTelegramChannels } from "./channels.js";

const ACTIVE_CHANNEL_STATUS = "active";
const ACTIVE_GRANT_STATUS = "active";

function iso(value) {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function tokenHash(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function normalizedAlias(value) {
  return String(value).trim().replace(/\s+/g, " ").toLowerCase();
}

function requireRecord(map, id, label) {
  const record = map.get(id);
  if (!record) throw new Error(`${label} ${id} does not exist.`);
  return record;
}

export class InMemorySaasStore {
  constructor({ clock = () => new Date() } = {}) {
    this.clock = clock;
    this.workspaces = new Map();
    this.users = new Map();
    this.credentialsByHash = new Map();
    this.authSubjects = new Map();
    this.revokedTokens = new Map();
    this.channels = new Map();
    this.previews = new Map();
    this.automationGrants = new Map();
    this.auditEvents = [];
    this.claimedPreviewIds = new Set();
    this.grantUsageByDay = new Map();
    this.publicationAttempts = new Map();
    this.publicationFingerprints = new Map();
  }

  now() {
    return this.clock();
  }

  addWorkspace({ id = randomUUID(), name, status = "active", createdAt = this.now() }) {
    const workspace = { id, name: name || id, status, createdAt: iso(createdAt) };
    this.workspaces.set(id, workspace);
    return workspace;
  }

  addUser({
    id = randomUUID(),
    workspaceId,
    email = null,
    status = "active",
    createdAt = this.now(),
  }) {
    requireRecord(this.workspaces, workspaceId, "Workspace");
    const user = { id, workspaceId, email, status, createdAt: iso(createdAt) };
    this.users.set(id, user);
    return user;
  }

  addCredential({
    id = randomUUID(),
    token,
    userId,
    workspaceId,
    status = "active",
    automationGrantId = null,
    allowDuplicatePublish = false,
    createdAt = this.now(),
  }) {
    if (typeof token !== "string" || token.length < 24) {
      throw new Error("Access tokens must contain at least 24 characters.");
    }
    const workspace = requireRecord(this.workspaces, workspaceId, "Workspace");
    const user = requireRecord(this.users, userId, "User");
    if (user.workspaceId !== workspace.id) {
      throw new Error("Credential user does not belong to the credential workspace.");
    }
    const credential = {
      id,
      userId,
      workspaceId,
      status,
      automationGrantId,
      allowDuplicatePublish: allowDuplicatePublish === true,
      createdAt: iso(createdAt),
    };
    if (automationGrantId) {
      const grant = requireRecord(this.automationGrants, automationGrantId, "Automation grant");
      if (grant.workspaceId !== workspaceId) {
        throw new Error("Credential automation grant does not belong to its workspace.");
      }
    }
    this.credentialsByHash.set(tokenHash(token), credential);
    return credential;
  }

  authenticate(token) {
    if (typeof token !== "string" || token.length < 24) return null;
    const credential = this.credentialsByHash.get(tokenHash(token));
    if (!credential || credential.status !== "active") return null;
    const user = this.users.get(credential.userId);
    const workspace = this.workspaces.get(credential.workspaceId);
    if (!user || user.status !== "active" || !workspace || workspace.status !== "active") {
      return null;
    }
    return {
      authSubjectId: credential.id,
      credentialId: credential.id,
      userId: user.id,
      workspaceId: workspace.id,
      automationGrantId: credential.automationGrantId,
      allowDuplicatePublish: credential.allowDuplicatePublish,
      scopes: null,
    };
  }

  addAuthSubject({
    id = randomUUID(),
    issuer,
    subject,
    userId,
    workspaceId,
    automationGrantId = null,
    allowDuplicatePublish = false,
    status = "active",
    createdAt = this.now(),
  }) {
    const workspace = requireRecord(this.workspaces, workspaceId, "Workspace");
    const user = requireRecord(this.users, userId, "User");
    if (user.workspaceId !== workspace.id) {
      throw new Error("OAuth subject user does not belong to its workspace.");
    }
    if (automationGrantId) {
      const grant = requireRecord(this.automationGrants, automationGrantId, "Automation grant");
      if (grant.workspaceId !== workspaceId) {
        throw new Error("OAuth subject automation grant does not belong to its workspace.");
      }
    }
    const key = `${issuer}\n${subject}`;
    if (this.authSubjects.has(key)) throw new Error("OAuth issuer/subject is already linked.");
    const record = {
      id,
      issuer,
      subject,
      userId,
      workspaceId,
      automationGrantId,
      allowDuplicatePublish: allowDuplicatePublish === true,
      status,
      createdAt: iso(createdAt),
    };
    this.authSubjects.set(key, record);
    return record;
  }

  resolveOAuthPrincipal({ issuer, subject }) {
    const record = this.authSubjects.get(`${issuer}\n${subject}`);
    if (!record || record.status !== "active") return null;
    const user = this.users.get(record.userId);
    const workspace = this.workspaces.get(record.workspaceId);
    if (!user || user.status !== "active" || !workspace || workspace.status !== "active") {
      return null;
    }
    return {
      authSubjectId: record.id,
      credentialId: record.id,
      userId: record.userId,
      workspaceId: record.workspaceId,
      automationGrantId: record.automationGrantId,
      allowDuplicatePublish: record.allowDuplicatePublish,
    };
  }

  isTokenRevoked({ issuer, jti }) {
    const record = this.revokedTokens.get(`${issuer}\n${jti}`);
    if (!record) return false;
    return !record.expiresAt || new Date(record.expiresAt) > this.now();
  }

  revokeToken({ issuer, jti, expiresAt = null, reason = null }) {
    this.revokedTokens.set(`${issuer}\n${jti}`, {
      issuer,
      jti,
      expiresAt: expiresAt ? iso(expiresAt) : null,
      reason,
      revokedAt: iso(this.now()),
    });
  }

  addChannel({
    id = randomUUID(),
    workspaceId,
    telegramChatId,
    title,
    name,
    username = null,
    status = ACTIVE_CHANNEL_STATUS,
    botPermissions = { canPostMessages: false },
    isDefault = false,
    createdAt = this.now(),
  }) {
    requireRecord(this.workspaces, workspaceId, "Workspace");
    const duplicate = [...this.channels.values()].find(
      (channel) =>
        channel.workspaceId === workspaceId &&
        channel.telegramChatId === String(telegramChatId),
    );
    if (duplicate) {
      throw new Error(`Telegram channel ${telegramChatId} already belongs to this workspace.`);
    }
    const channel = {
      id,
      workspaceId,
      telegramChatId: String(telegramChatId),
      title: title || name || String(telegramChatId),
      name: name || title || String(telegramChatId),
      username,
      status,
      botPermissions: { ...botPermissions },
      isDefault: isDefault === true,
      createdAt: iso(createdAt),
    };
    this.channels.set(id, channel);
    return channel;
  }

  listChannels(workspaceId) {
    return [...this.channels.values()].filter(
      (channel) =>
        channel.workspaceId === workspaceId && channel.status === ACTIVE_CHANNEL_STATUS,
    );
  }

  resolveChannels(workspaceId, requestedIdsOrAliases) {
    const available = this.listChannels(workspaceId);
    if (!requestedIdsOrAliases?.length) {
      const defaultChannel = available.find((channel) => channel.isDefault);
      if (!defaultChannel) {
        throw new Error("No default Telegram channel is configured for this workspace.");
      }
      if (defaultChannel.botPermissions.canPostMessages !== true) {
        throw new Error(`Telegram bot cannot post messages to channel ${defaultChannel.name}.`);
      }
      return [defaultChannel];
    }

    const resolved = [];
    const usedIds = new Set();
    for (const requested of requestedIdsOrAliases) {
      const alias = normalizedAlias(requested);
      const channel = available.find(
        (candidate) =>
          candidate.id === requested || normalizedAlias(candidate.name) === alias,
      );
      if (!channel) {
        throw new Error(`Telegram channel ${requested} is not available in this workspace.`);
      }
      if (channel.botPermissions.canPostMessages !== true) {
        throw new Error(`Telegram bot cannot post messages to channel ${channel.name}.`);
      }
      if (usedIds.has(channel.id)) throw new Error(`Telegram channel ${channel.name} is duplicated.`);
      usedIds.add(channel.id);
      resolved.push(channel);
    }
    return resolved;
  }

  createPreview({
    workspaceId,
    channelIds,
    hash,
    content,
    options,
    formatted,
    ttlSeconds = 900,
  }) {
    requireRecord(this.workspaces, workspaceId, "Workspace");
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error("Preview TTL must be a positive number of seconds.");
    }
    const createdAt = this.now();
    const preview = {
      id: randomUUID(),
      workspaceId,
      channelIds: [...channelIds],
      hash,
      content,
      options,
      formatted,
      status: "prepared",
      createdAt: iso(createdAt),
      expiresAt: iso(new Date(createdAt.getTime() + ttlSeconds * 1000)),
      publishedAt: null,
      cancelledAt: null,
    };
    this.previews.set(preview.id, preview);
    return preview;
  }

  getPreview(workspaceId, previewId) {
    const preview = this.previews.get(previewId);
    if (!preview || preview.workspaceId !== workspaceId) return null;
    if (preview.status === "prepared" && new Date(preview.expiresAt) <= this.now()) {
      preview.status = "expired";
    }
    return preview;
  }

  claimPreview(workspaceId, previewId, { allowDuplicate = false } = {}) {
    const preview = this.getPreview(workspaceId, previewId);
    if (!preview) throw new Error("Preview does not exist in this workspace.");
    if (this.claimedPreviewIds.has(preview.id)) {
      throw new Error("Preview is already being published.");
    }
    if (preview.status === "expired") throw new Error("Preview has expired. Prepare a new preview.");
    if (preview.status === "cancelled") throw new Error("Preview was cancelled.");
    if (preview.status === "published" && !allowDuplicate) {
      throw new Error("Preview was already published. Use an explicitly authorized duplicate flow.");
    }
    if (preview.status !== "prepared" && !(allowDuplicate && preview.status === "published")) {
      throw new Error(`Preview cannot be published from status ${preview.status}.`);
    }
    this.claimedPreviewIds.add(preview.id);
    return preview;
  }

  finishPreview(previewId, status) {
    const preview = requireRecord(this.previews, previewId, "Preview");
    this.claimedPreviewIds.delete(previewId);
    preview.status = status;
    if (status === "published") preview.publishedAt = iso(this.now());
    if (status === "cancelled") preview.cancelledAt = iso(this.now());
    return preview;
  }

  releasePreview(previewId) {
    this.claimedPreviewIds.delete(previewId);
  }

  addAutomationGrant({
    id = randomUUID(),
    workspaceId,
    allowedChannelIds,
    autonomousPublish = false,
    maxPostsPerRun = 1,
    maxPostsPerDay = 1,
    status = ACTIVE_GRANT_STATUS,
    revokedAt = null,
    createdAt = this.now(),
  }) {
    requireRecord(this.workspaces, workspaceId, "Workspace");
    if (!Number.isInteger(maxPostsPerRun) || maxPostsPerRun < 1) {
      throw new Error("Automation grant maxPostsPerRun must be a positive integer.");
    }
    if (!Number.isInteger(maxPostsPerDay) || maxPostsPerDay < maxPostsPerRun) {
      throw new Error(
        "Automation grant maxPostsPerDay must be an integer at least maxPostsPerRun.",
      );
    }
    const allowed = [...allowedChannelIds];
    for (const channelId of allowed) {
      const channel = this.channels.get(channelId);
      if (!channel || channel.workspaceId !== workspaceId) {
        throw new Error(`Automation grant channel ${channelId} is outside its workspace.`);
      }
    }
    const grant = {
      id,
      workspaceId,
      allowedChannelIds: allowed,
      autonomousPublish: autonomousPublish === true,
      maxPostsPerRun,
      maxPostsPerDay,
      status,
      revokedAt: revokedAt ? iso(revokedAt) : null,
      createdAt: iso(createdAt),
    };
    this.automationGrants.set(id, grant);
    return grant;
  }

  authorizeAutomation(principal, channelIds) {
    if (!principal.automationGrantId) {
      throw new Error("Scheduled publication requires an automation-bound credential.");
    }
    const grant = this.automationGrants.get(principal.automationGrantId);
    if (
      !grant ||
      grant.workspaceId !== principal.workspaceId ||
      grant.status !== ACTIVE_GRANT_STATUS ||
      grant.revokedAt ||
      !grant.autonomousPublish
    ) {
      throw new Error("Automation grant is missing, inactive, revoked, or cannot publish autonomously.");
    }
    if (channelIds.some((channelId) => !grant.allowedChannelIds.includes(channelId))) {
      throw new Error("Automation grant does not allow every preview channel.");
    }
    if (channelIds.length > grant.maxPostsPerRun) {
      throw new Error("Automation grant maxPostsPerRun would be exceeded.");
    }

    const day = this.now().toISOString().slice(0, 10);
    const usageKey = `${grant.id}:${day}`;
    const used = this.grantUsageByDay.get(usageKey) ?? 0;
    if (used + channelIds.length > grant.maxPostsPerDay) {
      throw new Error("Automation grant maxPostsPerDay would be exceeded.");
    }
    // Reserve before the external side effect. Failed/ambiguous attempts consume quota.
    this.grantUsageByDay.set(usageKey, used + channelIds.length);
    return grant;
  }

  beginPublication({
    principal,
    previewId,
    previewSha256,
    publicationMode = "interactive",
    allowDuplicate = false,
  }) {
    const preview = this.getPreview(principal.workspaceId, previewId);
    if (!preview) throw new Error("Preview does not exist in this workspace.");
    if (preview.hash !== previewSha256) {
      throw new Error("Preview SHA-256 does not match the stored preview.");
    }
    const channels = this.resolveChannels(principal.workspaceId, preview.channelIds);
    this.claimPreview(principal.workspaceId, previewId, { allowDuplicate });
    try {
      if (publicationMode === "scheduled") {
        if (allowDuplicate) throw new Error("Scheduled publication cannot use allowDuplicate=true.");
        this.authorizeAutomation(principal, preview.channelIds);
      } else if (allowDuplicate && !principal.allowDuplicatePublish) {
        throw new Error("This credential is not allowed to use the duplicate publication flow.");
      }
    } catch (error) {
      this.releasePreview(previewId);
      throw error;
    }

    const id = randomUUID();
    const attempt = {
      id,
      principal,
      preview,
      channels,
      publishChannels: [],
      duplicatePublications: [],
      publicationMode,
      allowDuplicate,
      status: "in_progress",
      startedAt: iso(this.now()),
    };
    for (const channel of channels) {
      const fingerprintKey = `${principal.workspaceId}:${channel.id}:${preview.formatted.contentSha256}`;
      if (!allowDuplicate && this.publicationFingerprints.has(fingerprintKey)) {
        attempt.duplicatePublications.push({
          channelId: channel.id,
          channelName: channel.name,
          chatId: channel.telegramChatId,
          status: "duplicate_prevented",
          messageId: null,
          channelTitle: channel.title,
          publishedAt: null,
          url: null,
          error: null,
        });
      } else {
        attempt.publishChannels.push(channel);
        if (!allowDuplicate) {
          this.publicationFingerprints.set(fingerprintKey, {
            attemptId: id,
            status: "reserved",
          });
        }
      }
    }
    preview.status = "publishing";
    preview.claimedAt = iso(this.now());
    this.publicationAttempts.set(id, attempt);
    return attempt;
  }

  completePublicationAttempt(attempt, result) {
    const stored = requireRecord(this.publicationAttempts, attempt.id, "Publication attempt");
    if (stored.status !== "in_progress") throw new Error("Publication attempt is not in progress.");
    const previewStatus = result.status === "failed" ? "cancelled" : "published";
    for (const publication of result.publications) {
      const fingerprintKey = `${attempt.principal.workspaceId}:${publication.channelId}:${attempt.preview.formatted.contentSha256}`;
      const fingerprint = this.publicationFingerprints.get(fingerprintKey);
      if (fingerprint?.attemptId === attempt.id) {
        fingerprint.status = publication.status === "published" ? "published" : "failed_ambiguous";
      }
      this.appendAudit({
        initiatorUserId: attempt.principal.userId,
        authSubjectId: attempt.principal.authSubjectId ?? attempt.principal.credentialId,
        credentialId: attempt.principal.credentialId,
        publicationMode: attempt.publicationMode,
        automationGrantId:
          attempt.publicationMode === "scheduled" ? attempt.principal.automationGrantId : null,
        workspaceId: attempt.principal.workspaceId,
        previewId: attempt.preview.id,
        attemptId: attempt.id,
        channelId: publication.channelId,
        telegramChatId: publication.chatId,
        telegramMessageId: publication.messageId,
        result: publication.status,
        error: publication.error,
      });
    }
    stored.status = result.status;
    stored.completedAt = iso(this.now());
    this.finishPreview(attempt.preview.id, previewStatus);
    return { ...result, previewId: attempt.preview.id, previewStatus };
  }

  failPublicationAttempt(attempt, error, { ambiguous = false } = {}) {
    const stored = requireRecord(this.publicationAttempts, attempt.id, "Publication attempt");
    // A caller failure after a successful commit must not rewrite durable
    // completion into cancelled/ambiguous state.
    if (stored.status !== "in_progress") return stored;
    const resultStatus = ambiguous ? "ambiguous" : "failed_pre_send";
    for (const channel of attempt.publishChannels) {
      const fingerprintKey = `${attempt.principal.workspaceId}:${channel.id}:${attempt.preview.formatted.contentSha256}`;
      const fingerprint = this.publicationFingerprints.get(fingerprintKey);
      if (fingerprint?.attemptId === attempt.id) {
        if (ambiguous) fingerprint.status = "failed_ambiguous";
        else this.publicationFingerprints.delete(fingerprintKey);
      }
      this.appendAudit({
        initiatorUserId: attempt.principal.userId,
        authSubjectId: attempt.principal.authSubjectId ?? attempt.principal.credentialId,
        credentialId: attempt.principal.credentialId,
        publicationMode: attempt.publicationMode,
        automationGrantId:
          attempt.publicationMode === "scheduled" ? attempt.principal.automationGrantId : null,
        workspaceId: attempt.principal.workspaceId,
        previewId: attempt.preview.id,
        attemptId: attempt.id,
        channelId: channel.id,
        telegramChatId: channel.telegramChatId,
        telegramMessageId: null,
        result: resultStatus,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    stored.status = resultStatus;
    stored.error = error instanceof Error ? error.message : String(error);
    stored.completedAt = iso(this.now());
    this.finishPreview(attempt.preview.id, "cancelled");
  }

  recordPublicationDenial({ principal, previewId, publicationMode, error }) {
    const preview = this.getPreview(principal.workspaceId, previewId);
    if (!preview) return;
    let channels = [];
    try {
      channels = this.resolveChannels(principal.workspaceId, preview.channelIds);
    } catch {
      return;
    }
    for (const channel of channels) {
      this.appendAudit({
        initiatorUserId: principal.userId,
        authSubjectId: principal.authSubjectId ?? principal.credentialId,
        credentialId: principal.credentialId,
        publicationMode,
        automationGrantId:
          publicationMode === "scheduled" ? principal.automationGrantId : null,
        workspaceId: principal.workspaceId,
        previewId,
        channelId: channel.id,
        telegramChatId: channel.telegramChatId,
        telegramMessageId: null,
        result: "denied",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  appendAudit(event) {
    const auditEvent = {
      id: randomUUID(),
      timestamp: iso(this.now()),
      ...event,
    };
    this.auditEvents.push(auditEvent);
    return auditEvent;
  }

  listAuditEvents(workspaceId) {
    return this.auditEvents.filter((event) => event.workspaceId === workspaceId);
  }
}

export function createLegacySaasContext(env = process.env) {
  const store = new InMemorySaasStore();
  const workspace = store.addWorkspace({ id: "legacy-workspace", name: "Legacy workspace" });
  const user = store.addUser({ id: "legacy-user", workspaceId: workspace.id });
  const legacyChannels = listTelegramChannels(env);
  for (const listed of legacyChannels) {
    const resolved = resolveTelegramChannels([listed.name], env)[0];
    store.addChannel({
      id: `legacy-${createHash("sha256").update(resolved.id).digest("hex").slice(0, 16)}`,
      workspaceId: workspace.id,
      telegramChatId: resolved.id,
      title: listed.name,
      name: listed.name,
      status: "active",
      botPermissions: { canPostMessages: true },
      isDefault: listed.isDefault,
    });
  }
  return {
    store,
    principal: {
      authSubjectId: "legacy-credential",
      credentialId: "legacy-credential",
      userId: user.id,
      workspaceId: workspace.id,
      automationGrantId: null,
      allowDuplicatePublish: true,
      scopes: null,
    },
  };
}

export function createSaasStoreFromEnv(env = process.env) {
  const raw = env.SAAS_BOOTSTRAP_JSON?.trim();
  if (!raw) throw new Error("SAAS_BOOTSTRAP_JSON is not configured.");
  let seed;
  try {
    seed = JSON.parse(raw);
  } catch {
    throw new Error("SAAS_BOOTSTRAP_JSON must be valid JSON.");
  }
  const store = new InMemorySaasStore();
  for (const workspace of seed.workspaces ?? []) store.addWorkspace(workspace);
  for (const user of seed.users ?? []) store.addUser(user);
  for (const channel of seed.channels ?? []) store.addChannel(channel);
  for (const grant of seed.automationGrants ?? []) store.addAutomationGrant(grant);
  for (const subject of seed.authSubjects ?? []) store.addAuthSubject(subject);
  for (const credential of seed.credentials ?? []) store.addCredential(credential);
  return store;
}

export { tokenHash };
