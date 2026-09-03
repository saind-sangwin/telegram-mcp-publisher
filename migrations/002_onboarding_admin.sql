CREATE UNIQUE INDEX telegram_channels_global_chat_id_unique
  ON telegram_channels (telegram_chat_id);

CREATE TABLE telegram_onboarding_challenges (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  user_id UUID NOT NULL REFERENCES users(id),
  token_hash CHAR(64) NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'telegram_linked', 'consumed', 'expired', 'cancelled')),
  telegram_user_id BIGINT,
  telegram_username TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL,
  linked_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ
);

CREATE INDEX telegram_onboarding_challenges_workspace_status_idx
  ON telegram_onboarding_challenges (workspace_id, status, expires_at);

CREATE TABLE telegram_identities (
  telegram_user_id BIGINT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX telegram_identities_user_idx ON telegram_identities (user_id);

CREATE TABLE telegram_webhook_updates (
  update_id BIGINT PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
