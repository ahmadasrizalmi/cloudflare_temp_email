-- Migration: 2026-05-15-billing-wallet.sql
-- Adds billing tables: wallets, credit_ledger, topup_transactions,
-- pricing_rules, payment_channels_cache, allowed_domains, billing_audit_logs.
-- Seeds default pricing_rules (12 rows) and allowed_domains (6 rows).
-- Back-fills wallets for all existing users (idempotent via INSERT OR IGNORE).
-- Requirements: 3.4, 5.8, 6.4, 7.3, 14.7, 18.6

-- ============================================================
-- Table: wallets
-- One row per user. Created eagerly at register or lazily on
-- first wallet read. CHECK (balance_credit >= 0) is the DB-level
-- guard against negative balances.
-- ============================================================
CREATE TABLE IF NOT EXISTS wallets (
  user_id         INTEGER PRIMARY KEY REFERENCES users(id),
  balance_credit  INTEGER NOT NULL DEFAULT 0 CHECK (balance_credit >= 0),
  balance_idr_ref INTEGER NOT NULL DEFAULT 0,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- Table: credit_ledger
-- Append-only ledger of every credit mutation.
-- CHECK enforces sign/type invariant (Property 3).
-- UNIQUE partial index on (idempotency_key, type) prevents
-- double-crediting on webhook replay (Property 20).
-- ============================================================
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

-- ============================================================
-- Table: topup_transactions
-- One row per top-up attempt. UNIQUE(invoice_id) and
-- UNIQUE(provider_reference) are the second idempotency layer
-- (Requirement 5.8).
-- ============================================================
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

-- ============================================================
-- Table: pricing_rules
-- Versioned key/value store for all pricing configuration.
-- Only the row with is_active=1 and MAX(version) per rule_key
-- is used at runtime (Requirement 7.7).
-- ============================================================
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

-- ============================================================
-- Table: payment_channels_cache
-- Mirrored from DompetX list API. Refreshed by admin or
-- stale-while-revalidate (TTL 10 min).
-- ============================================================
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

-- ============================================================
-- Table: allowed_domains
-- Domains on which users may create temp addresses.
-- Requirement 2.1 lists the six initial active domains.
-- ============================================================
CREATE TABLE IF NOT EXISTS allowed_domains (
  domain        TEXT PRIMARY KEY,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by    INTEGER
);

-- ============================================================
-- Table: billing_audit_logs
-- Append-only log for admin actions and system events
-- (pricing update, credit adjust, channel refresh, margin guard,
-- IP block, webhook invalid signature, domain add/remove).
-- ============================================================
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

-- ============================================================
-- Back-fill: create a wallet row for every existing user.
-- INSERT OR IGNORE makes this idempotent on repeated runs
-- (Requirement 14.7, Property 34).
-- ============================================================
INSERT OR IGNORE INTO wallets (user_id, balance_credit, balance_idr_ref, created_at, updated_at)
  SELECT id, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM users;

-- ============================================================
-- Seed: default pricing_rules (12 rows, version=1, is_active=1)
-- Values from design.md §"Default pricing_rules seed"
-- (Requirement 7.3).
-- INSERT OR IGNORE keeps the seed idempotent on re-runs because
-- UNIQUE(rule_key, version) prevents duplicate version-1 rows.
-- ============================================================
INSERT OR IGNORE INTO pricing_rules (rule_key, rule_value_json, version, is_active)
VALUES
  ('domain_weight_com',          '4',     1, 1),
  ('domain_weight_default',      '1',     1, 1),
  ('action_cost_create_address', '1',     1, 1),
  ('action_cost_send_mail',      '5',     1, 1),
  ('action_cost_forward_mail',   '5',     1, 1),
  ('credit_idr_rate',            '100',   1, 1),
  ('bonus_threshold_idr',        '100000',1, 1),
  ('bonus_rate_percent',         '5',     1, 1),
  ('min_topup_idr',              '10000', 1, 1),
  ('margin_guard_auto',          'true',  1, 1),
  ('margin_guard_target_percent','55',    1, 1),
  ('grandfather_period_days',    '30',    1, 1);

-- ============================================================
-- Seed: allowed_domains — six active domains (Requirement 2.1)
-- INSERT OR IGNORE is idempotent on re-runs.
-- ============================================================
INSERT OR IGNORE INTO allowed_domains (domain, is_active)
VALUES
  ('automation.my.id',    1),
  ('jagoseo.web.id',      1),
  ('resepkue.web.id',     1),
  ('resepmakanan.web.id', 1),
  ('sarapanbakery.com',   1),
  ('tawaf.my.id',         1);
