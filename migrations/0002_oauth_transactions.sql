CREATE TABLE oauth_transactions (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'discord')),
  code_verifier TEXT NOT NULL,
  redirect_after TEXT NOT NULL DEFAULT '/',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_oauth_transactions_expires_at
ON oauth_transactions(expires_at);
