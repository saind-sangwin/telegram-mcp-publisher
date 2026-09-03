import { randomUUID } from "node:crypto";
import { createPostgresPool } from "./db.js";
import { tokenHash } from "./saas-store.js";

function iso(value) {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function normalizedAlias(value) {
  return String(value).trim().replace(/\s+/g, " ").toLowerCase();
}

function mapChannel(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    telegramChatId: row.telegram_chat_id,
    title: row.title,
    name: row.name,
    username: row.username,
    status: row.status,
    botPermissions: row.bot_permissions,
    isDefault: row.is_default,
    createdAt: iso(row.created_at),
  };
}

function mapPreview(row, channelIds = []) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    channelIds,
    hash: row.hash,
    content: row.content,
    options: row.options,
    formatted: row.formatted,
    status: row.status,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    publishedAt: iso(row.published_at),
    cancelledAt: iso(row.cancelled_at),
  };
}

function mapAutomationGrant(row, allowedChannelIds = []) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    autonomousPublish: row.autonomous_publish,
    maxPostsPerRun: row.max_posts_per_run,
    maxPostsPerDay: row.max_posts_per_day,
    status: row.status,
    revokedAt: iso(row.revoked_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    allowedChannelIds,
  };
}

function assertCanPost(channel) {
  if (channel.botPermissions?.canPostMessages !== true) {
    throw new Error(`Telegram bot cannot post messages to channel ${channel.name}.`);
  }
}

function publicationCounts(publications) {
  const publishedCount = publications.filter((item) => item.status === "published").length;
  const duplicatePreventedCount = publications.filter(
    (item) => item.status === "duplicate_prevented",
  ).length;
  const failedCount = publications.filter((item) => item.status === "failed").length;
  return { publishedCount, duplicatePreventedCount, failedCount };
}

export class PostgresSaasStore {
  constructor(pool, { clock = () => new Date() } = {}) {
    this.pool = pool;
    this.clock = clock;
  }

  now() {
    return this.clock();
  }

  async close() {
    await this.pool.end();
  }

  async addWorkspace({ id = randomUUID(), name, status = "active", createdAt = this.now() }) {
    const { rows } = await this.pool.query(
      `INSERT INTO workspaces (id, name, status, created_at)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id, name || id, status, createdAt],
    );
    return {
      id: rows[0].id,
      name: rows[0].name,
      status: rows[0].status,
      createdAt: iso(rows[0].created_at),
    };
  }

  async addUser({
    id = randomUUID(),
    workspaceId,
    email = null,
    status = "active",
    role = "owner",
    createdAt = this.now(),
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `INSERT INTO users (id, email, status, created_at)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [id, email, status, createdAt],
      );
      await client.query(
        `INSERT INTO workspace_memberships (workspace_id, user_id, role, status, created_at)
         VALUES ($1, $2, $3, 'active', $4)`,
        [workspaceId, id, role, createdAt],
      );
      await client.query("COMMIT");
      return {
        id: rows[0].id,
        workspaceId,
        email: rows[0].email,
        status: rows[0].status,
        createdAt: iso(rows[0].created_at),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async addChannel({
    id = randomUUID(),
    workspaceId,
    telegramChatId,
    title,
    name,
    username = null,
    status = "active",
    botPermissions = { canPostMessages: false },
    isDefault = false,
    createdAt = this.now(),
  }) {
    const { rows } = await this.pool.query(
      `INSERT INTO telegram_channels
       (id, workspace_id, telegram_chat_id, title, name, username, status,
        bot_permissions, is_default, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $10)
       RETURNING *`,
      [
        id,
        workspaceId,
        String(telegramChatId),
        title || name || String(telegramChatId),
        name || title || String(telegramChatId),
        username,
        status,
        JSON.stringify(botPermissions),
        isDefault === true,
        createdAt,
      ],
    );
    return mapChannel(rows[0]);
  }

  async addAutomationGrant({
    id = randomUUID(),
    workspaceId,
    allowedChannelIds,
    autonomousPublish = false,
    maxPostsPerRun = 1,
    maxPostsPerDay = 1,
    status = "active",
    revokedAt = null,
    bindPrincipal = null,
    createdAt = this.now(),
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO automation_grants
         (id, workspace_id, autonomous_publish, max_posts_per_run, max_posts_per_day,
          status, revoked_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        [
          id,
          workspaceId,
          autonomousPublish === true,
          maxPostsPerRun,
          maxPostsPerDay,
          status,
          revokedAt,
          createdAt,
        ],
      );
      for (const channelId of allowedChannelIds) {
        await client.query(
          `INSERT INTO automation_grant_channels (automation_grant_id, channel_id)
           SELECT $1, id FROM telegram_channels WHERE id = $2 AND workspace_id = $3`,
          [id, channelId, workspaceId],
        );
      }
      const { rows } = await client.query(
        `SELECT COUNT(*)::integer AS count
         FROM automation_grant_channels WHERE automation_grant_id = $1`,
        [id],
      );
      if (rows[0].count !== allowedChannelIds.length) {
        throw new Error("Automation grant contains a channel outside its workspace.");
      }
      if (bindPrincipal) {
        if (!autonomousPublish) {
          throw new Error("Only an autonomous publishing grant can be bound to an OAuth subject.");
        }
        const bound = await client.query(
          `UPDATE auth_subjects SET automation_grant_id = $1
           WHERE id = $2 AND workspace_id = $3 AND user_id = $4 AND status = 'active'
           RETURNING id`,
          [id, bindPrincipal.authSubjectId, workspaceId, bindPrincipal.userId],
        );
        if (!bound.rowCount) throw new Error("Current OAuth subject cannot be bound to this grant.");
      }
      await client.query("COMMIT");
      return {
        id,
        workspaceId,
        allowedChannelIds: [...allowedChannelIds],
        boundAuthSubjectId: bindPrincipal?.authSubjectId ?? null,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async addCredential({
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
    await this.pool.query(
      `INSERT INTO opaque_credentials
       (id, token_hash, user_id, workspace_id, automation_grant_id,
        allow_duplicate_publish, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        tokenHash(token),
        userId,
        workspaceId,
        automationGrantId,
        allowDuplicatePublish === true,
        status,
        createdAt,
      ],
    );
    return { id, userId, workspaceId, automationGrantId, allowDuplicatePublish, status };
  }

  async addAuthSubject({
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
    await this.pool.query(
      `INSERT INTO auth_subjects
       (id, issuer, subject, user_id, workspace_id, automation_grant_id,
        allow_duplicate_publish, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        issuer,
        subject,
        userId,
        workspaceId,
        automationGrantId,
        allowDuplicatePublish === true,
        status,
        createdAt,
      ],
    );
    return { id, issuer, subject, userId, workspaceId, automationGrantId };
  }

  async bootstrapOAuthSubject({ issuer, subject, email = null, workspaceName }) {
    const existing = await this.getOAuthProfile({ issuer, subject });
    if (existing) return { ...existing, created: false };

    const client = await this.pool.connect();
    const now = this.now();
    const workspaceId = randomUUID();
    const userId = randomUUID();
    const authSubjectId = randomUUID();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO workspaces (id, name, status, created_at)
         VALUES ($1, $2, 'active', $3)`,
        [workspaceId, workspaceName, now],
      );
      await client.query(
        `INSERT INTO users (id, email, status, created_at)
         VALUES ($1, $2, 'active', $3)`,
        [userId, email, now],
      );
      await client.query(
        `INSERT INTO workspace_memberships
         (workspace_id, user_id, role, status, created_at)
         VALUES ($1, $2, 'owner', 'active', $3)`,
        [workspaceId, userId, now],
      );
      await client.query(
        `INSERT INTO auth_subjects
         (id, issuer, subject, user_id, workspace_id, status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'active', $6)`,
        [authSubjectId, issuer, subject, userId, workspaceId, now],
      );
      await client.query("COMMIT");
      return {
        created: true,
        authSubjectId,
        issuer,
        subject,
        user: { id: userId, email, status: "active", createdAt: iso(now) },
        workspace: { id: workspaceId, name: workspaceName, status: "active", createdAt: iso(now) },
        membership: { role: "owner", status: "active" },
      };
    } catch (error) {
      await client.query("ROLLBACK");
      const raced = await this.getOAuthProfile({ issuer, subject });
      if (raced) return { ...raced, created: false };
      throw error;
    } finally {
      client.release();
    }
  }

  async getOAuthProfile({ issuer, subject }) {
    const { rows } = await this.pool.query(
      `SELECT s.id AS auth_subject_id, s.issuer, s.subject,
              u.id AS user_id, u.email, u.status AS user_status, u.created_at AS user_created_at,
              w.id AS workspace_id, w.name AS workspace_name,
              w.status AS workspace_status, w.created_at AS workspace_created_at,
              m.role, m.status AS membership_status
       FROM auth_subjects s
       JOIN users u ON u.id = s.user_id
       JOIN workspaces w ON w.id = s.workspace_id
       JOIN workspace_memberships m ON m.workspace_id = s.workspace_id AND m.user_id = s.user_id
       WHERE s.issuer = $1 AND s.subject = $2 AND s.status = 'active'`,
      [issuer, subject],
    );
    if (!rows[0]) return null;
    const row = rows[0];
    return {
      authSubjectId: row.auth_subject_id,
      issuer: row.issuer,
      subject: row.subject,
      user: {
        id: row.user_id,
        email: row.email,
        status: row.user_status,
        createdAt: iso(row.user_created_at),
      },
      workspace: {
        id: row.workspace_id,
        name: row.workspace_name,
        status: row.workspace_status,
        createdAt: iso(row.workspace_created_at),
      },
      membership: { role: row.role, status: row.membership_status },
    };
  }

  async getPrincipalProfile(principal) {
    return this.getOAuthProfile({ issuer: principal.issuer, subject: principal.subject });
  }

  async authenticate(token) {
    if (typeof token !== "string" || token.length < 24) return null;
    const { rows } = await this.pool.query(
      `SELECT c.id, c.user_id, c.workspace_id, c.automation_grant_id,
              c.allow_duplicate_publish, m.role
       FROM opaque_credentials c
       JOIN users u ON u.id = c.user_id AND u.status = 'active'
       JOIN workspaces w ON w.id = c.workspace_id AND w.status = 'active'
       JOIN workspace_memberships m ON m.workspace_id = c.workspace_id
         AND m.user_id = c.user_id AND m.status = 'active'
       WHERE c.token_hash = $1 AND c.status = 'active'`,
      [tokenHash(token)],
    );
    if (!rows[0]) return null;
    return {
      authSubjectId: rows[0].id,
      credentialId: rows[0].id,
      userId: rows[0].user_id,
      workspaceId: rows[0].workspace_id,
      automationGrantId: rows[0].automation_grant_id,
      allowDuplicatePublish: rows[0].allow_duplicate_publish,
      role: rows[0].role,
      scopes: null,
    };
  }

  async resolveOAuthPrincipal({ issuer, subject }) {
    const { rows } = await this.pool.query(
      `SELECT s.id, s.user_id, s.workspace_id, s.automation_grant_id,
              s.allow_duplicate_publish, m.role
       FROM auth_subjects s
       JOIN users u ON u.id = s.user_id AND u.status = 'active'
       JOIN workspaces w ON w.id = s.workspace_id AND w.status = 'active'
       JOIN workspace_memberships m ON m.workspace_id = s.workspace_id
         AND m.user_id = s.user_id AND m.status = 'active'
       WHERE s.issuer = $1 AND s.subject = $2 AND s.status = 'active'`,
      [issuer, subject],
    );
    if (!rows[0]) return null;
    return {
      authSubjectId: rows[0].id,
      credentialId: rows[0].id,
      userId: rows[0].user_id,
      workspaceId: rows[0].workspace_id,
      automationGrantId: rows[0].automation_grant_id,
      allowDuplicatePublish: rows[0].allow_duplicate_publish,
      role: rows[0].role,
    };
  }

  async listAdminChannels(workspaceId) {
    const { rows } = await this.pool.query(
      `SELECT * FROM telegram_channels
       WHERE workspace_id = $1
       ORDER BY is_default DESC, created_at ASC`,
      [workspaceId],
    );
    return rows.map(mapChannel);
  }

  async createOnboardingChallenge({
    workspaceId,
    userId,
    tokenHash,
    ttlSeconds = 600,
  }) {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 3600) {
      throw new Error("Onboarding challenge TTL must be between 60 and 3600 seconds.");
    }
    const id = randomUUID();
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + ttlSeconds * 1000);
    await this.pool.query(
      `INSERT INTO telegram_onboarding_challenges
       (id, workspace_id, user_id, token_hash, status, created_at, expires_at)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6)`,
      [id, workspaceId, userId, tokenHash, createdAt, expiresAt],
    );
    return { id, workspaceId, userId, status: "pending", createdAt: iso(createdAt), expiresAt: iso(expiresAt) };
  }

  async claimTelegramWebhookUpdate(updateId) {
    const { rowCount } = await this.pool.query(
      `INSERT INTO telegram_webhook_updates (update_id, received_at)
       VALUES ($1, $2) ON CONFLICT (update_id) DO NOTHING`,
      [String(updateId), this.now()],
    );
    return rowCount === 1;
  }

  async linkTelegramChallenge({ tokenHash, telegramUser }) {
    const client = await this.pool.connect();
    const now = this.now();
    try {
      await client.query("BEGIN");
      const challengeResult = await client.query(
        `SELECT * FROM telegram_onboarding_challenges
         WHERE token_hash = $1 FOR UPDATE`,
        [tokenHash],
      );
      const challenge = challengeResult.rows[0];
      if (!challenge) {
        await client.query("COMMIT");
        return null;
      }
      if (new Date(challenge.expires_at) <= now && ["pending", "telegram_linked"].includes(challenge.status)) {
        await client.query(
          `UPDATE telegram_onboarding_challenges SET status = 'expired' WHERE id = $1`,
          [challenge.id],
        );
        await client.query("COMMIT");
        return null;
      }
      if (!["pending", "telegram_linked"].includes(challenge.status)) {
        await client.query("COMMIT");
        return null;
      }
      const telegramUserId = String(telegramUser.id);
      const identity = await client.query(
        `SELECT user_id FROM telegram_identities WHERE telegram_user_id = $1 FOR UPDATE`,
        [telegramUserId],
      );
      if (identity.rows[0] && identity.rows[0].user_id !== challenge.user_id) {
        throw new Error("This Telegram account is already linked to another service user.");
      }
      await client.query(
        `INSERT INTO telegram_identities
         (telegram_user_id, user_id, username, first_name, last_name, linked_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         ON CONFLICT (telegram_user_id) DO UPDATE
         SET username = EXCLUDED.username, first_name = EXCLUDED.first_name,
             last_name = EXCLUDED.last_name, updated_at = EXCLUDED.updated_at`,
        [
          telegramUserId,
          challenge.user_id,
          telegramUser.username ?? null,
          telegramUser.first_name ?? null,
          telegramUser.last_name ?? null,
          now,
        ],
      );
      await client.query(
        `UPDATE telegram_onboarding_challenges
         SET status = 'telegram_linked', telegram_user_id = $2,
             telegram_username = $3, linked_at = $4
         WHERE id = $1`,
        [challenge.id, telegramUserId, telegramUser.username ?? null, now],
      );
      await client.query("COMMIT");
      return {
        id: challenge.id,
        workspaceId: challenge.workspace_id,
        userId: challenge.user_id,
        telegramUserId,
        status: "telegram_linked",
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getOnboardingChallenge(workspaceId, userId, challengeId) {
    const { rows } = await this.pool.query(
      `SELECT * FROM telegram_onboarding_challenges
       WHERE id = $1 AND workspace_id = $2 AND user_id = $3`,
      [challengeId, workspaceId, userId],
    );
    if (!rows[0]) return null;
    const row = rows[0];
    if (["pending", "telegram_linked"].includes(row.status) && new Date(row.expires_at) <= this.now()) {
      await this.pool.query(
        `UPDATE telegram_onboarding_challenges SET status = 'expired'
         WHERE id = $1 AND status IN ('pending', 'telegram_linked')`,
        [challengeId],
      );
      row.status = "expired";
    }
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      userId: row.user_id,
      status: row.status,
      telegramUserId: row.telegram_user_id === null ? null : String(row.telegram_user_id),
      telegramUsername: row.telegram_username,
      expiresAt: iso(row.expires_at),
    };
  }

  async finalizeOnboardingChannel({
    workspaceId,
    userId,
    challengeId,
    telegramChatId,
    title,
    name,
    username = null,
    botPermissions,
    isDefault = false,
  }) {
    const client = await this.pool.connect();
    const now = this.now();
    try {
      await client.query("BEGIN");
      const challengeResult = await client.query(
        `SELECT * FROM telegram_onboarding_challenges
         WHERE id = $1 AND workspace_id = $2 AND user_id = $3 FOR UPDATE`,
        [challengeId, workspaceId, userId],
      );
      const challenge = challengeResult.rows[0];
      if (!challenge) throw new Error("Onboarding challenge does not exist in this workspace.");
      if (challenge.status !== "telegram_linked") {
        throw new Error(`Onboarding challenge is ${challenge.status}; link Telegram first.`);
      }
      if (new Date(challenge.expires_at) <= now) throw new Error("Onboarding challenge has expired.");

      const existingResult = await client.query(
        `SELECT * FROM telegram_channels WHERE telegram_chat_id = $1 FOR UPDATE`,
        [String(telegramChatId)],
      );
      const existing = existingResult.rows[0];
      if (existing && existing.workspace_id !== workspaceId) {
        throw new Error("This Telegram channel is already owned by another workspace.");
      }
      const activeCount = await client.query(
        `SELECT COUNT(*)::integer AS count FROM telegram_channels
         WHERE workspace_id = $1 AND status = 'active'`,
        [workspaceId],
      );
      const shouldBeDefault = isDefault === true || activeCount.rows[0].count === 0;
      if (shouldBeDefault) {
        await client.query(
          `UPDATE telegram_channels SET is_default = FALSE, updated_at = $2
           WHERE workspace_id = $1 AND is_default = TRUE`,
          [workspaceId, now],
        );
      }
      let channelRow;
      if (existing) {
        const updated = await client.query(
          `UPDATE telegram_channels
           SET title = $3, name = $4, username = $5, status = 'active',
               bot_permissions = $6::jsonb,
               is_default = CASE WHEN $7 THEN TRUE ELSE is_default END,
               updated_at = $8
           WHERE id = $1 AND workspace_id = $2 RETURNING *`,
          [existing.id, workspaceId, title, name, username, JSON.stringify(botPermissions), shouldBeDefault, now],
        );
        channelRow = updated.rows[0];
      } else {
        const inserted = await client.query(
          `INSERT INTO telegram_channels
           (id, workspace_id, telegram_chat_id, title, name, username, status,
            bot_permissions, is_default, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'active', $7::jsonb, $8, $9, $9)
           RETURNING *`,
          [randomUUID(), workspaceId, String(telegramChatId), title, name, username, JSON.stringify(botPermissions), shouldBeDefault, now],
        );
        channelRow = inserted.rows[0];
      }
      await client.query(
        `UPDATE telegram_onboarding_challenges
         SET status = 'consumed', consumed_at = $2 WHERE id = $1`,
        [challengeId, now],
      );
      await client.query("COMMIT");
      return mapChannel(channelRow);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async disableChannel(workspaceId, channelId) {
    const { rows } = await this.pool.query(
      `UPDATE telegram_channels
       SET status = 'disabled', is_default = FALSE, updated_at = $3
       WHERE id = $1 AND workspace_id = $2
       RETURNING *`,
      [channelId, workspaceId, this.now()],
    );
    return rows[0] ? mapChannel(rows[0]) : null;
  }

  async listAutomationGrants(workspaceId) {
    const { rows } = await this.pool.query(
      `SELECT * FROM automation_grants WHERE workspace_id = $1 ORDER BY created_at DESC`,
      [workspaceId],
    );
    const result = [];
    for (const row of rows) {
      const channels = await this.pool.query(
        `SELECT channel_id FROM automation_grant_channels
         WHERE automation_grant_id = $1 ORDER BY channel_id`,
        [row.id],
      );
      result.push(mapAutomationGrant(row, channels.rows.map((item) => item.channel_id)));
    }
    return result;
  }

  async bindAutomationGrantToSubject(principal, grantId) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const grant = await client.query(
        `SELECT id FROM automation_grants
         WHERE id = $1 AND workspace_id = $2 AND status = 'active'
           AND revoked_at IS NULL AND autonomous_publish = TRUE FOR UPDATE`,
        [grantId, principal.workspaceId],
      );
      if (!grant.rowCount) throw new Error("Active autonomous grant does not exist in this workspace.");
      const bound = await client.query(
        `UPDATE auth_subjects SET automation_grant_id = $1
         WHERE id = $2 AND workspace_id = $3 AND user_id = $4 AND status = 'active'
         RETURNING id`,
        [grantId, principal.authSubjectId, principal.workspaceId, principal.userId],
      );
      if (!bound.rowCount) throw new Error("Current OAuth subject cannot be bound to this grant.");
      await client.query("COMMIT");
      return { grantId, authSubjectId: principal.authSubjectId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeAutomationGrant(workspaceId, grantId) {
    const client = await this.pool.connect();
    const now = this.now();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `UPDATE automation_grants
         SET status = 'revoked', revoked_at = $3, updated_at = $3
         WHERE id = $1 AND workspace_id = $2 AND status <> 'revoked'
         RETURNING *`,
        [grantId, workspaceId, now],
      );
      if (!rows[0]) throw new Error("Automation grant does not exist or is already revoked.");
      await client.query(
        `UPDATE auth_subjects SET automation_grant_id = NULL
         WHERE workspace_id = $1 AND automation_grant_id = $2`,
        [workspaceId, grantId],
      );
      await client.query("COMMIT");
      const channels = await this.pool.query(
        `SELECT channel_id FROM automation_grant_channels WHERE automation_grant_id = $1`,
        [grantId],
      );
      return mapAutomationGrant(rows[0], channels.rows.map((item) => item.channel_id));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async isTokenRevoked({ issuer, jti }) {
    const { rowCount } = await this.pool.query(
      `SELECT 1 FROM revoked_tokens
       WHERE issuer = $1 AND jti = $2
         AND (expires_at IS NULL OR expires_at > $3)`,
      [issuer, jti, this.now()],
    );
    return rowCount > 0;
  }

  async revokeToken({ issuer, jti, expiresAt = null, reason = null }) {
    await this.pool.query(
      `INSERT INTO revoked_tokens (issuer, jti, expires_at, reason, revoked_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (issuer, jti) DO UPDATE
       SET expires_at = EXCLUDED.expires_at, reason = EXCLUDED.reason,
           revoked_at = EXCLUDED.revoked_at`,
      [issuer, jti, expiresAt, reason, this.now()],
    );
  }

  async listChannels(workspaceId) {
    const { rows } = await this.pool.query(
      `SELECT * FROM telegram_channels
       WHERE workspace_id = $1 AND status = 'active'
       ORDER BY is_default DESC, created_at ASC`,
      [workspaceId],
    );
    return rows.map(mapChannel);
  }

  async resolveChannels(workspaceId, requestedIdsOrAliases) {
    const available = await this.listChannels(workspaceId);
    if (!requestedIdsOrAliases?.length) {
      const channel = available.find((candidate) => candidate.isDefault);
      if (!channel) throw new Error("No default Telegram channel is configured for this workspace.");
      assertCanPost(channel);
      return [channel];
    }
    const resolved = [];
    const used = new Set();
    for (const requested of requestedIdsOrAliases) {
      const alias = normalizedAlias(requested);
      const channel = available.find(
        (candidate) => candidate.id === requested || normalizedAlias(candidate.name) === alias,
      );
      if (!channel) throw new Error(`Telegram channel ${requested} is not available in this workspace.`);
      assertCanPost(channel);
      if (used.has(channel.id)) throw new Error(`Telegram channel ${channel.name} is duplicated.`);
      used.add(channel.id);
      resolved.push(channel);
    }
    return resolved;
  }

  async createPreview({
    workspaceId,
    channelIds,
    hash,
    content,
    options,
    formatted,
    ttlSeconds = 900,
  }) {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error("Preview TTL must be a positive number of seconds.");
    }
    const channels = await this.resolveChannels(workspaceId, channelIds);
    const id = randomUUID();
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + ttlSeconds * 1000);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO previews
         (id, workspace_id, hash, content, publication_format, options, formatted,
          status, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 'prepared', $8, $9)`,
        [
          id,
          workspaceId,
          hash,
          content,
          formatted.publicationFormat,
          JSON.stringify(options),
          JSON.stringify(formatted),
          createdAt,
          expiresAt,
        ],
      );
      for (let ordinal = 0; ordinal < channels.length; ordinal += 1) {
        await client.query(
          `INSERT INTO preview_channels (preview_id, channel_id, ordinal)
           VALUES ($1, $2, $3)`,
          [id, channels[ordinal].id, ordinal],
        );
      }
      await client.query("COMMIT");
      return {
        id,
        workspaceId,
        channelIds: channels.map((channel) => channel.id),
        hash,
        content,
        options,
        formatted,
        status: "prepared",
        createdAt: iso(createdAt),
        expiresAt: iso(expiresAt),
        publishedAt: null,
        cancelledAt: null,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getPreview(workspaceId, previewId) {
    const { rows } = await this.pool.query(
      `SELECT * FROM previews WHERE id = $1 AND workspace_id = $2`,
      [previewId, workspaceId],
    );
    if (!rows[0]) return null;
    if (rows[0].status === "prepared" && new Date(rows[0].expires_at) <= this.now()) {
      await this.pool.query(
        `UPDATE previews SET status = 'expired'
         WHERE id = $1 AND workspace_id = $2 AND status = 'prepared'`,
        [previewId, workspaceId],
      );
      rows[0].status = "expired";
    }
    const channelRows = await this.pool.query(
      `SELECT pc.channel_id
       FROM preview_channels pc
       JOIN telegram_channels c ON c.id = pc.channel_id
       WHERE pc.preview_id = $1 AND c.workspace_id = $2
       ORDER BY pc.ordinal`,
      [previewId, workspaceId],
    );
    return mapPreview(rows[0], channelRows.rows.map((row) => row.channel_id));
  }

  async beginPublication({
    principal,
    previewId,
    previewSha256,
    publicationMode = "interactive",
    allowDuplicate = false,
  }) {
    const client = await this.pool.connect();
    const now = this.now();
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      const previewResult = await client.query(
        `SELECT * FROM previews WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
        [previewId, principal.workspaceId],
      );
      const row = previewResult.rows[0];
      if (!row) throw new Error("Preview does not exist in this workspace.");
      if (row.hash !== previewSha256) throw new Error("Preview SHA-256 does not match the stored preview.");
      if (row.status === "prepared" && new Date(row.expires_at) <= now) {
        await client.query(
          "UPDATE previews SET status = 'expired' WHERE id = $1 AND workspace_id = $2",
          [previewId, principal.workspaceId],
        );
        await client.query("COMMIT");
        transactionOpen = false;
        throw new Error("Preview has expired. Prepare a new preview.");
      }
      if (row.status === "expired") throw new Error("Preview has expired. Prepare a new preview.");
      if (row.status === "cancelled") throw new Error("Preview was cancelled.");
      if (row.status === "publishing") throw new Error("Preview is already being published.");
      if (row.status === "published" && !allowDuplicate) {
        throw new Error("Preview was already published. Use an explicitly authorized duplicate flow.");
      }
      if (row.status !== "prepared" && !(allowDuplicate && row.status === "published")) {
        throw new Error(`Preview cannot be published from status ${row.status}.`);
      }
      if (allowDuplicate && !principal.allowDuplicatePublish) {
        throw new Error("This credential is not allowed to use the duplicate publication flow.");
      }
      if (publicationMode === "scheduled" && allowDuplicate) {
        throw new Error("Scheduled publication cannot use allowDuplicate=true.");
      }

      const channelResult = await client.query(
        `SELECT c.*, pc.ordinal
         FROM preview_channels pc
         JOIN telegram_channels c ON c.id = pc.channel_id
         WHERE pc.preview_id = $1 AND c.workspace_id = $2 AND c.status = 'active'
         ORDER BY pc.ordinal`,
        [previewId, principal.workspaceId],
      );
      const channels = channelResult.rows.map(mapChannel);
      if (!channels.length) throw new Error("Preview has no active channels in this workspace.");
      for (const channel of channels) assertCanPost(channel);

      if (publicationMode === "scheduled") {
        if (!principal.automationGrantId) {
          throw new Error("Scheduled publication requires an automation-bound credential.");
        }
        const grantResult = await client.query(
          `SELECT * FROM automation_grants
           WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
          [principal.automationGrantId, principal.workspaceId],
        );
        const grant = grantResult.rows[0];
        if (
          !grant ||
          grant.status !== "active" ||
          grant.revoked_at ||
          !grant.autonomous_publish
        ) {
          throw new Error("Automation grant is missing, inactive, revoked, or cannot publish autonomously.");
        }
        const allowedResult = await client.query(
          `SELECT channel_id FROM automation_grant_channels WHERE automation_grant_id = $1`,
          [grant.id],
        );
        const allowed = new Set(allowedResult.rows.map((allowedRow) => allowedRow.channel_id));
        if (channels.some((channel) => !allowed.has(channel.id))) {
          throw new Error("Automation grant does not allow every preview channel.");
        }
        if (channels.length > grant.max_posts_per_run) {
          throw new Error("Automation grant maxPostsPerRun would be exceeded.");
        }
        const usageDate = now.toISOString().slice(0, 10);
        await client.query(
          `INSERT INTO automation_usage (automation_grant_id, usage_date, posts_reserved, updated_at)
           VALUES ($1, $2, 0, $3)
           ON CONFLICT (automation_grant_id, usage_date) DO NOTHING`,
          [grant.id, usageDate, now],
        );
        const reserved = await client.query(
          `UPDATE automation_usage
           SET posts_reserved = posts_reserved + $3, updated_at = $4
           WHERE automation_grant_id = $1 AND usage_date = $2
             AND posts_reserved + $3 <= $5
           RETURNING posts_reserved`,
          [grant.id, usageDate, channels.length, now, grant.max_posts_per_day],
        );
        if (!reserved.rowCount) {
          throw new Error("Automation grant maxPostsPerDay would be exceeded.");
        }
      }

      const attemptId = randomUUID();
      const idempotencyKey = allowDuplicate
        ? `${previewId}:${previewSha256}:${attemptId}`
        : `${previewId}:${previewSha256}`;
      await client.query(
        `INSERT INTO publication_attempts
         (id, workspace_id, preview_id, initiator_user_id, auth_subject_id,
          automation_grant_id, publication_mode, allow_duplicate, idempotency_key,
          status, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'in_progress', $10)`,
        [
          attemptId,
          principal.workspaceId,
          previewId,
          principal.userId,
          principal.authSubjectId ?? principal.credentialId,
          publicationMode === "scheduled" ? principal.automationGrantId : null,
          publicationMode,
          allowDuplicate,
          idempotencyKey,
          now,
        ],
      );

      const publishChannels = [];
      const duplicatePublications = [];
      for (const channel of channels) {
        if (allowDuplicate) {
          publishChannels.push(channel);
          continue;
        }
        const fingerprint = await client.query(
          `INSERT INTO publication_fingerprints
           (workspace_id, channel_id, content_sha256, attempt_id, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'reserved', $5, $5)
           ON CONFLICT (workspace_id, channel_id, content_sha256) DO NOTHING
           RETURNING attempt_id`,
          [principal.workspaceId, channel.id, row.formatted.contentSha256, attemptId, now],
        );
        if (fingerprint.rows[0]?.attempt_id === attemptId) {
          publishChannels.push(channel);
        } else {
          duplicatePublications.push({
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
        }
      }

      await client.query(
        `UPDATE previews SET status = 'publishing', claimed_at = $2
         WHERE id = $1 AND workspace_id = $3`,
        [previewId, now, principal.workspaceId],
      );
      await client.query("COMMIT");
      transactionOpen = false;
      return {
        id: attemptId,
        principal,
        preview: mapPreview(row, channels.map((channel) => channel.id)),
        channels,
        publishChannels,
        duplicatePublications,
        publicationMode,
        allowDuplicate,
      };
    } catch (error) {
      if (transactionOpen) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async completePublicationAttempt(attempt, result) {
    const client = await this.pool.connect();
    const now = this.now();
    try {
      await client.query("BEGIN");
      const locked = await client.query(
        `SELECT status FROM publication_attempts
         WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
        [attempt.id, attempt.principal.workspaceId],
      );
      if (locked.rows[0]?.status !== "in_progress") {
        throw new Error("Publication attempt is not in progress.");
      }
      for (const publication of result.publications) {
        await client.query(
          `INSERT INTO publication_results
           (id, attempt_id, channel_id, telegram_chat_id, status,
            telegram_message_id, channel_title, published_at, url, error, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            randomUUID(),
            attempt.id,
            publication.channelId,
            publication.chatId,
            publication.status,
            publication.messageId,
            publication.channelTitle,
            publication.publishedAt,
            publication.url,
            publication.error,
            now,
          ],
        );
        if (publication.status === "published") {
          await client.query(
            `UPDATE publication_fingerprints
             SET status = 'published', updated_at = $4
             WHERE workspace_id = $1 AND channel_id = $2
               AND content_sha256 = $3 AND attempt_id = $5`,
            [
              attempt.principal.workspaceId,
              publication.channelId,
              attempt.preview.formatted.contentSha256,
              now,
              attempt.id,
            ],
          );
        } else if (publication.status === "failed") {
          await client.query(
            `UPDATE publication_fingerprints
             SET status = 'failed_ambiguous', updated_at = $4
             WHERE workspace_id = $1 AND channel_id = $2
               AND content_sha256 = $3 AND attempt_id = $5`,
            [
              attempt.principal.workspaceId,
              publication.channelId,
              attempt.preview.formatted.contentSha256,
              now,
              attempt.id,
            ],
          );
        }
        await this.#insertAudit(client, {
          id: randomUUID(),
          workspaceId: attempt.principal.workspaceId,
          initiatorUserId: attempt.principal.userId,
          authSubjectId: attempt.principal.authSubjectId ?? attempt.principal.credentialId,
          publicationMode: attempt.publicationMode,
          automationGrantId:
            attempt.publicationMode === "scheduled"
              ? attempt.principal.automationGrantId
              : null,
          previewId: attempt.preview.id,
          attemptId: attempt.id,
          channelId: publication.channelId,
          telegramChatId: publication.chatId,
          telegramMessageId: publication.messageId,
          result: publication.status,
          error: publication.error,
          timestamp: now,
        });
      }
      const previewStatus = result.status === "failed" ? "cancelled" : "published";
      await client.query(
        `UPDATE previews
         SET status = $2,
             published_at = CASE WHEN $2 = 'published' THEN $3 ELSE published_at END,
             cancelled_at = CASE WHEN $2 = 'cancelled' THEN $3 ELSE cancelled_at END
         WHERE id = $1 AND workspace_id = $4`,
        [attempt.preview.id, previewStatus, now, attempt.principal.workspaceId],
      );
      await client.query(
        `UPDATE publication_attempts
         SET status = $2, completed_at = $3
         WHERE id = $1 AND workspace_id = $4`,
        [attempt.id, result.status, now, attempt.principal.workspaceId],
      );
      await client.query("COMMIT");
      return { ...result, previewId: attempt.preview.id, previewStatus };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async failPublicationAttempt(attempt, error, { ambiguous = false } = {}) {
    const client = await this.pool.connect();
    const now = this.now();
    const status = ambiguous ? "ambiguous" : "failed_pre_send";
    try {
      await client.query("BEGIN");
      const locked = await client.query(
        `SELECT status FROM publication_attempts
         WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
        [attempt.id, attempt.principal.workspaceId],
      );
      if (locked.rows[0]?.status !== "in_progress") {
        await client.query("COMMIT");
        return locked.rows[0] ?? null;
      }
      if (ambiguous) {
        await client.query(
          `UPDATE publication_fingerprints
           SET status = 'failed_ambiguous', updated_at = $2
           WHERE attempt_id = $1 AND workspace_id = $3`,
          [attempt.id, now, attempt.principal.workspaceId],
        );
      } else {
        await client.query(
          "DELETE FROM publication_fingerprints WHERE attempt_id = $1 AND workspace_id = $2",
          [attempt.id, attempt.principal.workspaceId],
        );
      }
      await client.query(
        `UPDATE publication_attempts
         SET status = $2, error = $3, completed_at = $4
         WHERE id = $1 AND workspace_id = $5 AND status = 'in_progress'`,
        [
          attempt.id,
          status,
          error instanceof Error ? error.message : String(error),
          now,
          attempt.principal.workspaceId,
        ],
      );
      await client.query(
        `UPDATE previews SET status = 'cancelled', cancelled_at = $2
         WHERE id = $1 AND workspace_id = $3 AND status = 'publishing'`,
        [attempt.preview.id, now, attempt.principal.workspaceId],
      );
      for (const channel of attempt.publishChannels) {
        const resultStatus = ambiguous ? "ambiguous" : "failed_pre_send";
        await client.query(
          `INSERT INTO publication_results
           (id, attempt_id, channel_id, telegram_chat_id, status,
            channel_title, error, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (attempt_id, channel_id) DO NOTHING`,
          [
            randomUUID(),
            attempt.id,
            channel.id,
            channel.telegramChatId,
            resultStatus,
            channel.title,
            error instanceof Error ? error.message : String(error),
            now,
          ],
        );
        await this.#insertAudit(client, {
          id: randomUUID(),
          workspaceId: attempt.principal.workspaceId,
          initiatorUserId: attempt.principal.userId,
          authSubjectId: attempt.principal.authSubjectId ?? attempt.principal.credentialId,
          publicationMode: attempt.publicationMode,
          automationGrantId:
            attempt.publicationMode === "scheduled"
              ? attempt.principal.automationGrantId
              : null,
          previewId: attempt.preview.id,
          attemptId: attempt.id,
          channelId: channel.id,
          telegramChatId: channel.telegramChatId,
          telegramMessageId: null,
          result: resultStatus,
          error: error instanceof Error ? error.message : String(error),
          timestamp: now,
        });
      }
      await client.query("COMMIT");
    } catch (failure) {
      await client.query("ROLLBACK");
      throw failure;
    } finally {
      client.release();
    }
  }

  async recordPublicationDenial({ principal, previewId, publicationMode, error }) {
    const preview = await this.getPreview(principal.workspaceId, previewId);
    if (!preview) return;
    const channels = await this.resolveChannels(principal.workspaceId, preview.channelIds).catch(() => []);
    for (const channel of channels) {
      await this.appendAudit({
        workspaceId: principal.workspaceId,
        initiatorUserId: principal.userId,
        authSubjectId: principal.authSubjectId ?? principal.credentialId,
        publicationMode,
        automationGrantId:
          publicationMode === "scheduled" ? principal.automationGrantId : null,
        previewId,
        channelId: channel.id,
        telegramChatId: channel.telegramChatId,
        telegramMessageId: null,
        result: "denied",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async appendAudit(event) {
    const client = await this.pool.connect();
    try {
      return await this.#insertAudit(client, {
        id: randomUUID(),
        timestamp: this.now(),
        ...event,
      });
    } finally {
      client.release();
    }
  }

  async #insertAudit(client, event) {
    await client.query(
      `INSERT INTO audit_events
       (id, workspace_id, initiator_user_id, auth_subject_id, publication_mode,
        automation_grant_id, preview_id, attempt_id, channel_id, telegram_chat_id,
        telegram_message_id, result, error, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)`,
      [
        event.id,
        event.workspaceId,
        event.initiatorUserId ?? null,
        event.authSubjectId ?? event.credentialId ?? null,
        event.publicationMode ?? null,
        event.automationGrantId ?? null,
        event.previewId ?? null,
        event.attemptId ?? null,
        event.channelId ?? null,
        event.telegramChatId ?? null,
        event.telegramMessageId ?? null,
        event.result,
        event.error ?? null,
        JSON.stringify(event.metadata ?? {}),
        event.timestamp ?? this.now(),
      ],
    );
    return event;
  }

  async listAuditEvents(workspaceId) {
    const { rows } = await this.pool.query(
      `SELECT * FROM audit_events WHERE workspace_id = $1 ORDER BY created_at ASC`,
      [workspaceId],
    );
    return rows.map((row) => ({
      id: row.id,
      timestamp: iso(row.created_at),
      workspaceId: row.workspace_id,
      initiatorUserId: row.initiator_user_id,
      credentialId: row.auth_subject_id,
      publicationMode: row.publication_mode,
      automationGrantId: row.automation_grant_id,
      previewId: row.preview_id,
      attemptId: row.attempt_id,
      channelId: row.channel_id,
      telegramChatId: row.telegram_chat_id,
      telegramMessageId:
        row.telegram_message_id === null ? null : Number(row.telegram_message_id),
      result: row.result,
      error: row.error,
      metadata: row.metadata,
    }));
  }

  async cleanupRetention({ previewRetentionDays = 7, auditRetentionDays = 90 } = {}) {
    if (!Number.isFinite(previewRetentionDays) || previewRetentionDays < 1) {
      throw new Error("previewRetentionDays must be at least 1.");
    }
    if (!Number.isFinite(auditRetentionDays) || auditRetentionDays < 1) {
      throw new Error("auditRetentionDays must be at least 1.");
    }
    const now = this.now();
    const previewCutoff = new Date(now.getTime() - previewRetentionDays * 86_400_000);
    const auditCutoff = new Date(now.getTime() - auditRetentionDays * 86_400_000);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const expired = await client.query(
        `UPDATE previews SET status = 'expired'
         WHERE status = 'prepared' AND expires_at <= $1
         RETURNING id`,
        [now],
      );
      const revokedTokens = await client.query(
        `DELETE FROM revoked_tokens WHERE expires_at <= $1
         RETURNING jti`,
        [now],
      );
      const audit = await client.query(
        `DELETE FROM audit_events WHERE created_at < $1 RETURNING id`,
        [auditCutoff],
      );
      const previews = await client.query(
        `DELETE FROM previews
         WHERE status IN ('expired', 'cancelled')
           AND created_at < $1
           AND id NOT IN (SELECT preview_id FROM publication_attempts)
         RETURNING id`,
        [previewCutoff],
      );
      await client.query("COMMIT");
      return {
        expiredPreviews: expired.rows.length,
        deletedRevokedTokens: revokedTokens.rows.length,
        deletedAuditEvents: audit.rows.length,
        deletedPreviews: previews.rows.length,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recoverStalePublicationAttempts({ staleAfterSeconds = 300 } = {}) {
    if (!Number.isFinite(staleAfterSeconds) || staleAfterSeconds < 30) {
      throw new Error("staleAfterSeconds must be at least 30.");
    }
    const now = this.now();
    const cutoff = new Date(now.getTime() - staleAfterSeconds * 1000);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const stale = await client.query(
        `SELECT * FROM publication_attempts
         WHERE status = 'in_progress' AND started_at <= $1
         ORDER BY started_at
         FOR UPDATE SKIP LOCKED`,
        [cutoff],
      );
      for (const attempt of stale.rows) {
        await client.query(
          `UPDATE publication_attempts
           SET status = 'ambiguous',
               error = 'Recovered stale in-progress attempt; external outcome is unknown.',
               completed_at = $2
           WHERE id = $1`,
          [attempt.id, now],
        );
        await client.query(
          `UPDATE publication_fingerprints
           SET status = 'failed_ambiguous', updated_at = $2
           WHERE attempt_id = $1`,
          [attempt.id, now],
        );
        await client.query(
          `UPDATE previews SET status = 'cancelled', cancelled_at = $2
           WHERE id = $1 AND workspace_id = $3 AND status = 'publishing'`,
          [attempt.preview_id, now, attempt.workspace_id],
        );
        const channels = await client.query(
          `SELECT c.id, c.telegram_chat_id, c.title
           FROM publication_fingerprints f
           JOIN telegram_channels c
             ON c.id = f.channel_id AND c.workspace_id = f.workspace_id
           WHERE f.attempt_id = $1 AND f.workspace_id = $2`,
          [attempt.id, attempt.workspace_id],
        );
        for (const channel of channels.rows) {
          const error = "Recovered stale attempt; manual Telegram reconciliation is required.";
          await client.query(
            `INSERT INTO publication_results
             (id, attempt_id, channel_id, telegram_chat_id, status,
              channel_title, error, created_at)
             VALUES ($1, $2, $3, $4, 'ambiguous', $5, $6, $7)
             ON CONFLICT (attempt_id, channel_id) DO NOTHING`,
            [
              randomUUID(),
              attempt.id,
              channel.id,
              channel.telegram_chat_id,
              channel.title,
              error,
              now,
            ],
          );
          await this.#insertAudit(client, {
            id: randomUUID(),
            workspaceId: attempt.workspace_id,
            initiatorUserId: attempt.initiator_user_id,
            authSubjectId: attempt.auth_subject_id,
            publicationMode: attempt.publication_mode,
            automationGrantId: attempt.automation_grant_id,
            previewId: attempt.preview_id,
            attemptId: attempt.id,
            channelId: channel.id,
            telegramChatId: channel.telegram_chat_id,
            telegramMessageId: null,
            result: "ambiguous_recovered",
            error,
            timestamp: now,
          });
        }
      }
      await client.query("COMMIT");
      return { recoveredAttempts: stale.rowCount };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export function createPostgresSaasStoreFromEnv(env = process.env, options = {}) {
  return new PostgresSaasStore(createPostgresPool(env), options);
}

export { mapChannel, mapPreview, publicationCounts };
