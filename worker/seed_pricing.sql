-- Reset first
DELETE FROM pricing_rules;

-- Rules from PLAN_SAAS_TOPUP.md
INSERT INTO pricing_rules (rule_key, rule_value_json, version, is_active) VALUES ('domain_weight_com', '4', 1, 1);
INSERT INTO pricing_rules (rule_key, rule_value_json, version, is_active) VALUES ('domain_weight_default', '1', 1, 1);
INSERT INTO pricing_rules (rule_key, rule_value_json, version, is_active) VALUES ('action_cost_create_address', '1', 1, 1);
INSERT INTO pricing_rules (rule_key, rule_value_json, version, is_active) VALUES ('action_cost_send_mail', '0', 1, 1);
INSERT INTO pricing_rules (rule_key, rule_value_json, version, is_active) VALUES ('action_cost_forward_mail', '0', 1, 1);
INSERT INTO pricing_rules (rule_key, rule_value_json, version, is_active) VALUES ('credit_idr_rate', '100', 1, 1); -- 1 Credit = Rp 100
INSERT INTO pricing_rules (rule_key, rule_value_json, version, is_active) VALUES ('bonus_threshold_idr', '100000', 1, 1);
INSERT INTO pricing_rules (rule_key, rule_value_json, version, is_active) VALUES ('bonus_rate_percent', '5', 1, 1);
INSERT INTO pricing_rules (rule_key, rule_value_json, version, is_active) VALUES ('min_topup_idr', '10000', 1, 1);
INSERT INTO pricing_rules (rule_key, rule_value_json, version, is_active) VALUES ('margin_guard_auto', 'true', 1, 1);
INSERT INTO pricing_rules (rule_key, rule_value_json, version, is_active) VALUES ('margin_guard_target_percent', '55', 1, 1);
INSERT INTO pricing_rules (rule_key, rule_value_json, version, is_active) VALUES ('grandfather_period_days', '30', 1, 1);

-- Ensure domains exist
INSERT OR IGNORE INTO allowed_domains (domain, is_active) VALUES ('automation.my.id', 1);
INSERT OR IGNORE INTO allowed_domains (domain, is_active) VALUES ('jagoseo.web.id', 1);
INSERT OR IGNORE INTO allowed_domains (domain, is_active) VALUES ('resepkue.web.id', 1);
INSERT OR IGNORE INTO allowed_domains (domain, is_active) VALUES ('resepmakanan.web.id', 1);
INSERT OR IGNORE INTO allowed_domains (domain, is_active) VALUES ('sarapanbakery.com', 1);
INSERT OR IGNORE INTO allowed_domains (domain, is_active) VALUES ('tawaf.my.id', 1);
