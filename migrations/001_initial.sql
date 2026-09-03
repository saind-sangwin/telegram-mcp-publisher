CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE workspaces (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE users (
  id UUID PRIMARY KEY,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX users_email_unique
  ON users (LOWER(email))
  WHERE email IS NOT NULL;

CREATE TABLE workspace_memberships (
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  user_id UUID NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE telegram_channels (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  telegram_chat_id TEXT NOT NULL,
  title TEXT NOT NULL,
  name TEXT NOT NULL,
  username TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('pending', 'active', 'permission_lost', 'disabled')),
  bot_permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id, telegram_chat_id)
);

CREATE UNIQUE INDEX telegram_channels_one_default_per_workspace
  ON telegram_channels (workspace_id)
  WHERE is_default = TRUE AND status = 'active';

CREATE INDEX telegram_channels_workspace_status_idx
  ON telegram_channels (workspace_id, status);

CREATE TABLE automation_grants (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  autonomous_publish BOOLEAN NOT NULL DEFAULT FALSE,
  max_posts_per_run INTEGER NOT NULL CHECK (max_posts_per_run > 0),
  max_posts_per_day INTEGER NOT NULL CHECK (max_posts_per_day >= max_posts_per_run),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked')),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE automation_grant_channels (
  automation_grant_id UUID NOT NULL REFERENCES automation_grants(id) ON DELETE CASCADE,
  channel_id UUID NOT NULL REFERENCES telegram_channels(id),
  PRIMARY KEY (automation_grant_id, channel_id)
);

CREATE TABLE automation_usage (
  automation_grant_id UUID NOT NULL REFERENCES automation_grants(id) ON DELETE CASCADE,
  usage_date DATE NOT NULL,
  posts_reserved INTEGER NOT NULL DEFAULT 0 CHECK (posts_reserved >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (automation_grant_id, usage_date)
);

CREATE TABLE auth_subjects (
  id UUID PRIMARY KEY,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  automation_grant_id UUID REFERENCES automation_grants(id),
  allow_duplicate_publish BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (issuer, subject)
);

CREATE INDEX auth_subjects_workspace_idx ON auth_subjects (workspace_id);

CREATE TABLE opaque_credentials (
  id UUID PRIMARY KEY,
  token_hash CHAR(64) NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES users(id),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  automation_grant_id UUID REFERENCES automation_grants(id),
  allow_duplicate_publish BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE revoked_tokens (
  issuer TEXT NOT NULL,
  jti TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  reason TEXT,
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (issuer, jti)
);

CREATE INDEX revoked_tokens_expiry_idx ON revoked_tokens (expires_at);

CREATE TABLE previews (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  hash CHAR(64) NOT NULL,
  content TEXT NOT NULL,
  publication_format TEXT NOT NULL CHECK (publication_format IN ('classic', 'rich')),
  options JSONB NOT NULL,
  formatted JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'prepared'
    CHECK (status IN ('prepared', 'publishing', 'published', 'expired', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL,
  claimed_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ
);

CREATE INDEX previews_workspace_status_expiry_idx
  ON previews (workspace_id, status, expires_at);

CREATE TABLE preview_channels (
  preview_id UUID NOT NULL REFERENCES previews(id) ON DELETE CASCADE,
  channel_id UUID NOT NULL REFERENCES telegram_channels(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (preview_id, channel_id),
  UNIQUE (preview_id, ordinal)
);

CREATE TABLE publication_attempts (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  preview_id UUID NOT NULL REFERENCES previews(id),
  initiator_user_id UUID NOT NULL REFERENCES users(id),
  auth_subject_id TEXT NOT NULL,
  automation_grant_id UUID REFERENCES automation_grants(id),
  publication_mode TEXT NOT NULL CHECK (publication_mode IN ('interactive', 'scheduled')),
  allow_duplicate BOOLEAN NOT NULL DEFAULT FALSE,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'complete', 'partial', 'failed', 'failed_pre_send', 'ambiguous')),
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ
);

CREATE INDEX publication_attempts_workspace_started_idx
  ON publication_attempts (workspace_id, started_at DESC);

CREATE TABLE publication_results (
  id UUID PRIMARY KEY,
  attempt_id UUID NOT NULL REFERENCES publication_attempts(id) ON DELETE CASCADE,
  channel_id UUID NOT NULL REFERENCES telegram_channels(id),
  telegram_chat_id TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('published', 'duplicate_prevented', 'failed', 'failed_pre_send', 'ambiguous')),
  telegram_message_id BIGINT,
  channel_title TEXT,
  published_at TIMESTAMPTZ,
  url TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (attempt_id, channel_id)
);

CREATE TABLE publication_fingerprints (
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  channel_id UUID NOT NULL REFERENCES telegram_channels(id),
  content_sha256 CHAR(64) NOT NULL,
  attempt_id UUID NOT NULL REFERENCES publication_attempts(id),
  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'published', 'failed_ambiguous')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, channel_id, content_sha256)
);

CREATE TABLE audit_events (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  initiator_user_id UUID REFERENCES users(id),
  auth_subject_id TEXT,
  publication_mode TEXT,
  automation_grant_id UUID REFERENCES automation_grants(id),
  preview_id UUID REFERENCES previews(id),
  attempt_id UUID REFERENCES publication_attempts(id),
  channel_id UUID REFERENCES telegram_channels(id),
  telegram_chat_id TEXT,
  telegram_message_id BIGINT,
  result TEXT NOT NULL,
  error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX audit_events_workspace_created_idx
  ON audit_events (workspace_id, created_at DESC);
