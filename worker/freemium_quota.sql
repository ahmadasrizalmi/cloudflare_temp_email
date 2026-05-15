-- Freemium quota tracking migration
-- Run: wrangler d1 execute DB --file=./worker/freemium_quota.sql

-- Table to track how many free emails each user has created
CREATE TABLE IF NOT EXISTS user_free_quota (
  user_id     INTEGER PRIMARY KEY,
  email_used  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for quick lookup
CREATE INDEX IF NOT EXISTS idx_user_free_quota_user_id ON user_free_quota(user_id);

-- Pricing rule for freemium limit (how many free emails allowed)
-- Value: 1 means 1 free email per user
INSERT OR IGNORE INTO pricing_rules (rule_key, rule_value_json, version, is_active)
VALUES ('freemium_email_limit', '1', 1, 1);
