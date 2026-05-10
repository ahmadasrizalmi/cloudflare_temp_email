-- Authoritative schema — includes all migrations applied in order:
--   2024-01-13-patch.sql
--   2024-04-03-patch.sql
--   2024-04-09-patch.sql
--   2024-04-12-patch.sql
--   2024-05-01-patch.sql
--   2024-05-08-patch.sql
--   2024-07-14-patch.sql
--   2024-08-10-patch.sql
--   2025-09-23-patch.sql
--   2025-12-06-metadata.sql
--   2025-12-15-message-id-index.sql
--   2025-12-27-source-meta.sql
--   2026-04-03-raw-blob.sql
--   2026-05-15-billing-wallet.sql

CREATE TABLE IF NOT EXISTS raw_mails (
    id INTEGER PRIMARY KEY,
    message_id TEXT,
    source TEXT,
    address TEXT,
    raw TEXT,
    raw_blob BLOB,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_raw_mails_address ON raw_mails(address);

CREATE INDEX IF NOT EXISTS idx_raw_mails_created_at ON raw_mails(created_at);

CREATE INDEX IF NOT EXISTS idx_raw_mails_message_id ON raw_mails(message_id);

CREATE TABLE IF NOT EXISTS address (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    password TEXT,
    source_meta TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_address_name ON address(name);

CREATE INDEX IF NOT EXISTS idx_address_created_at ON address(created_at);

CREATE INDEX IF NOT EXISTS idx_address_updated_at ON address(updated_at);

CREATE INDEX IF NOT EXISTS idx_address_source_meta ON address(source_meta);

CREATE TABLE IF NOT EXISTS auto_reply_mails (
    id INTEGER PRIMARY KEY,
    source_prefix TEXT,
    name TEXT,
    address TEXT UNIQUE,
    subject TEXT,
    message TEXT,
    enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_auto_reply_mails_address ON auto_reply_mails(address);

CREATE TABLE IF NOT EXISTS address_sender (
    id INTEGER PRIMARY KEY,
    address TEXT UNIQUE,
    balance INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_address_sender_address ON address_sender(address);

CREATE TABLE IF NOT EXISTS sendbox (
    id INTEGER PRIMARY KEY,
    address TEXT,
    raw TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sendbox_address ON sendbox(address);

CREATE INDEX IF NOT EXISTS idx_sendbox_created_at ON sendbox(created_at);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    user_email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    user_info TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_user_email ON users(user_email);

CREATE TABLE IF NOT EXISTS users_address (
    id INTEGER PRIMARY KEY,
    user_id INTEGER,
    address_id INTEGER UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_address_user_id ON users_address(user_id);

CREATE INDEX IF NOT EXISTS idx_users_address_address_id ON users_address(address_id);

CREATE TABLE IF NOT EXISTS user_roles (
    id INTEGER PRIMARY KEY,
    user_id INTEGER UNIQUE NOT NULL,
    role_text TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles(user_id);

CREATE TABLE IF NOT EXISTS user_passkeys (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    passkey_name TEXT NOT NULL,
    passkey_id TEXT NOT NULL,
    passkey TEXT NOT NULL,
    counter INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_passkeys_user_id ON user_passkeys(user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_passkeys_user_id_passkey_id ON user_passkeys(user_id, passkey_id);

-- ============================================================
-- Billing tables (added by 2026-05-15-billing-wallet.sql)
-- ============================================================

CREATE TABLE IF NOT EXISTS wallets (
  user_id         INTEGER PRIMARY KEY REFERENCES users(id),
  balance_credit  INTEGER NOT NULL DEFAULT 0 CHECK (balance_credit >= 0),
  balance_idr_ref INTEGER NOT NULL DEFAULT 0,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  type             TEXT    NOT NULL
                     CHECK (type IN ('TOPUP','DEBIT','ADJUST','BONUS','REFUND')),
  credit_delta     INTEGER NOT NULL
                     CHECK (
                       (type = 'DEBIT'  AND credit_delta < 0) OR
                       (type IN ('TOPUP','BONUS','REFUND') AND credit_delta > 0) OR
                       (type = 'ADJUST' AND credit_delta != 0)
                     ),
  idr_ref          INTEGER,
  metadata         TEXT,
  idempotency_key  TEXT,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_credit_ledger_user_created
  ON credit_ledger(user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_idem_type
  ON credit_ledger(idempotency_key, type)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS topup_transactions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             INTEGER NOT NULL REFERENCES users(id),
  invoice_id          TEXT    NOT NULL UNIQUE,
  provider_reference  TEXT    UNIQUE,
  channel_code        TEXT    NOT NULL,
  amount              INTEGER NOT NULL,
  fee                 INTEGER NOT NULL DEFAULT 0,
  gross_amount        INTEGER NOT NULL,
  fee_bearer          TEXT    NOT NULL CHECK (fee_bearer IN ('customer','merchant')),
  status              TEXT    NOT NULL
                        CHECK (status IN ('pending','paid','failed','expired','cancelled')),
  fingerprint_hash    TEXT,
  ip                  TEXT,
  checkout_url        TEXT,
  expiry_minutes      INTEGER NOT NULL DEFAULT 30,
  raw_payload         TEXT,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at             DATETIME,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_topup_user_created
  ON topup_transactions(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_topup_status_created
  ON topup_transactions(status, created_at);

CREATE TABLE IF NOT EXISTS pricing_rules (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_key         TEXT    NOT NULL,
  rule_value_json  TEXT    NOT NULL,
  version          INTEGER NOT NULL,
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (rule_key, version)
);

CREATE INDEX IF NOT EXISTS idx_pricing_rules_active
  ON pricing_rules(rule_key, is_active, version DESC);

CREATE TABLE IF NOT EXISTS payment_channels_cache (
  channel_code  TEXT    PRIMARY KEY,
  name          TEXT    NOT NULL,
  "group"       TEXT,
  min           INTEGER NOT NULL,
  max           INTEGER,
  fee_type      TEXT    NOT NULL CHECK (fee_type IN ('percentage','fixed','mixed')),
  fee_value     INTEGER NOT NULL DEFAULT 0,
  fee_fixed     INTEGER NOT NULL DEFAULT 0,
  fee_bearer    TEXT    NOT NULL DEFAULT 'customer'
                  CHECK (fee_bearer IN ('customer','merchant')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  icon_url      TEXT,
  fetched_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS allowed_domains (
  domain        TEXT PRIMARY KEY,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by    INTEGER
);

CREATE TABLE IF NOT EXISTS billing_audit_logs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id       INTEGER,
  event_type     TEXT    NOT NULL,
  target_user_id INTEGER,
  rule_key       TEXT,
  old_value      TEXT,
  new_value      TEXT,
  reason         TEXT,
  metadata       TEXT,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_billing_audit_event
  ON billing_audit_logs(event_type, created_at DESC);
