/**
 * Billing_Admin_API — admin endpoints for managing billing configuration.
 *
 * Feature: saas-topup-billing
 * Task: 12.1 — pricing_rules GET and PUT
 * Requirements: 7.1, 7.3, 7.4, 7.5, 7.6, 7.7, 9.6
 *
 * This Hono app is mounted in `worker/src/admin_api/index.ts` (task 12.7) so
 * that the existing `/admin/*` middleware (`x-admin-auth`) applies uniformly.
 *
 * Endpoints implemented in this file:
 *   GET  /admin/billing/pricing_rules
 *   PUT  /admin/billing/pricing_rules
 *
 * Additional endpoints (topup transactions, channels refresh, credit adjust,
 * KPI, domains) are implemented in tasks 12.2 through 12.6.
 */

import { Context, Hono } from 'hono';

import i18n from '../i18n';
import { createPricingEngine } from '../billing/pricing_engine';
import type { PricingRuleRow, RuleKey } from '../models/billing';
import { BILLING_RULE_KEYS } from '../models/billing';

const api = new Hono<HonoCustomType>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Best-effort admin id extraction for audit logging. Returns null when the
 * admin authenticated via `x-admin-auth` password (no user identity attached).
 * Returns the JWT user_id when authenticated via `x-user-access-token` with
 * an admin role — though that path typically doesn't populate userPayload,
 * this keeps the helper forward-compatible.
 */
function getAdminIdForAudit(c: Context<HonoCustomType>): number | null {
    const userPayload = c.get('userPayload');
    return userPayload?.user_id ?? null;
}

/**
 * Parse the `rule_value_json` field from the admin PUT body. Accepts either:
 *   - A string containing valid JSON (e.g. `"4"`, `"true"`, `"{...}"`) — this
 *     matches the on-disk column shape exactly.
 *   - A raw value (number, boolean, object) — stringified before storage.
 *
 * Returns `{ inner, storage }`:
 *   - `inner`: parsed JS value used for validation
 *   - `storage`: canonical JSON-encoded string written to the DB column
 *
 * Throws on inputs that cannot be coerced into valid JSON.
 */
function parseRuleValue(raw: unknown): { inner: unknown; storage: string } {
    if (raw === undefined || raw === null) {
        throw new Error('rule_value_json is required');
    }
    if (typeof raw === 'string') {
        // String input: must be valid JSON (scalar or object literal).
        try {
            const inner = JSON.parse(raw);
            return { inner, storage: raw };
        } catch {
            throw new Error('rule_value_json is not valid JSON');
        }
    }
    // Non-string: stringify for storage; validation uses the raw value.
    return { inner: raw, storage: JSON.stringify(raw) };
}

/**
 * Ensure a value is a finite integer (not a float, NaN, or Infinity).
 */
function isInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
}

// ─── GET /admin/billing/pricing_rules ─────────────────────────────────────────
// Returns every pricing_rules row — both the active row per rule_key and all
// historical versions (is_active = 0). Sorted by rule_key ASC, version DESC
// so each key's current active row appears first, followed by its history.
// Requirements: 7.1

api.get('/admin/billing/pricing_rules', async (c) => {
    const { results } = await c.env.DB.prepare(
        `SELECT id, rule_key, rule_value_json, version, is_active, created_at
           FROM pricing_rules
          ORDER BY rule_key ASC, version DESC`
    ).all<PricingRuleRow>();

    return c.json(results ?? []);
});

// ─── PUT /admin/billing/pricing_rules ─────────────────────────────────────────
// Body: { rule_key, rule_value_json }
// Validates the rule_value_json payload against the per-rule guard rules from
// design.md §"Admin PUT pricing_rules validation":
//   - domain_weight_com ∈ [1, 5]           → else 400 margin_guard_violation
//   - min_topup_idr      ≥ 10000           → else 400 min_topup_violation
//   - credit_idr_rate    ≥ 1 (integer)     → else 400 invalid input
//   - bonus_rate_percent ∈ [0, 100]        → else 400 invalid input
//
// Writes a single D1 batch:
//   1. UPDATE pricing_rules SET is_active=0 WHERE rule_key=? AND is_active=1
//   2. INSERT new row with version = MAX(version)+1 and is_active=1
//   3. INSERT billing_audit_logs row (event_type='pricing_update')
//
// After commit, invalidates the Pricing_Engine module-level cache so the new
// value propagates immediately within the isolate (other isolates pick it up
// via the 60s TTL).
// Requirements: 7.1, 7.3, 7.4, 7.5, 7.6, 7.7, 9.6

api.put('/admin/billing/pricing_rules', async (c) => {
    const msgs = i18n.getMessagesbyContext(c);

    // ── Body parsing ─────────────────────────────────────────────────────────
    let body: { rule_key?: string; rule_value_json?: unknown };
    try {
        body = await c.req.json();
    } catch {
        return c.json({ error: 'invalid_input', message: msgs.InvalidInputMsg }, 400);
    }

    const rule_key = body?.rule_key;
    if (!rule_key || typeof rule_key !== 'string') {
        return c.json({ error: 'invalid_input', message: msgs.RequiredFieldMsg }, 400);
    }
    if (!(BILLING_RULE_KEYS as readonly string[]).includes(rule_key)) {
        return c.json({ error: 'invalid_input', message: msgs.InvalidInputMsg }, 400);
    }

    let inner: unknown;
    let storage: string;
    try {
        ({ inner, storage } = parseRuleValue(body?.rule_value_json));
    } catch {
        return c.json({ error: 'invalid_input', message: msgs.InvalidInputMsg }, 400);
    }

    // ── Per-rule validation ──────────────────────────────────────────────────
    switch (rule_key as RuleKey) {
        case 'domain_weight_com': {
            // Range [1, 5] — both bounds enforced as margin_guard_violation
            // per design.md §"Admin PUT pricing_rules validation".
            if (!isInteger(inner) || inner < 1 || inner > 5) {
                return c.json(
                    {
                        error: 'margin_guard_violation',
                        message: msgs.MarginGuardViolationMsg,
                    },
                    400,
                );
            }
            break;
        }
        case 'min_topup_idr': {
            if (!isInteger(inner) || inner < 10000) {
                return c.json(
                    {
                        error: 'min_topup_violation',
                        message: msgs.MinTopupViolationMsg,
                    },
                    400,
                );
            }
            break;
        }
        case 'credit_idr_rate': {
            if (!isInteger(inner) || inner < 1) {
                return c.json(
                    { error: 'invalid_input', message: msgs.InvalidInputMsg },
                    400,
                );
            }
            break;
        }
        case 'bonus_rate_percent': {
            // Accepts integer or fractional percentage in [0, 100].
            if (
                typeof inner !== 'number' ||
                !Number.isFinite(inner) ||
                inner < 0 ||
                inner > 100
            ) {
                return c.json(
                    { error: 'invalid_input', message: msgs.InvalidInputMsg },
                    400,
                );
            }
            break;
        }
        // Other rule keys (domain_weight_default, action_cost_*,
        // bonus_threshold_idr, margin_guard_auto, margin_guard_target_percent,
        // grandfather_period_days) don't have explicit numeric bounds in
        // task 12.1 — their validation is left to task 12.x or the DB layer.
        default:
            break;
    }

    // ── Pre-fetch old active value for audit trail ──────────────────────────
    // Read before the batch so we can record it as old_value in the audit row
    // without relying on subquery ordering inside the batch.
    const oldRow = await c.env.DB.prepare(
        `SELECT rule_value_json
           FROM pricing_rules
          WHERE rule_key = ? AND is_active = 1
          ORDER BY version DESC
          LIMIT 1`
    )
        .bind(rule_key)
        .first<{ rule_value_json: string }>();
    const oldValue = oldRow?.rule_value_json ?? null;

    const adminId = getAdminIdForAudit(c);

    // ── Build batch statements ───────────────────────────────────────────────
    // Statement 1: deactivate the currently active row (if any).
    const deactivateStmt = c.env.DB.prepare(
        `UPDATE pricing_rules
            SET is_active = 0
          WHERE rule_key = ? AND is_active = 1`
    ).bind(rule_key);

    // Statement 2: insert the new active row with version = MAX+1. The
    // subquery reads pricing_rules BEFORE the current batch's INSERT runs,
    // so even if statement 1 already flipped is_active, the MAX(version) is
    // still correct (it includes all rows regardless of is_active).
    const insertRuleStmt = c.env.DB.prepare(
        `INSERT INTO pricing_rules (rule_key, rule_value_json, version, is_active)
         VALUES (
             ?,
             ?,
             (SELECT COALESCE(MAX(version), 0) + 1 FROM pricing_rules WHERE rule_key = ?),
             1
         )
         RETURNING version`
    ).bind(rule_key, storage, rule_key);

    // Statement 3: audit log.
    const auditStmt = c.env.DB.prepare(
        `INSERT INTO billing_audit_logs
             (admin_id, event_type, target_user_id, rule_key, old_value, new_value, reason, metadata, created_at)
         VALUES (?, 'pricing_update', NULL, ?, ?, ?, NULL, NULL, CURRENT_TIMESTAMP)`
    ).bind(adminId, rule_key, oldValue, storage);

    // ── Execute atomically ───────────────────────────────────────────────────
    const batchResults = await c.env.DB.batch<{ version: number }>([
        deactivateStmt,
        insertRuleStmt,
        auditStmt,
    ]);

    // The INSERT statement's RETURNING surfaces the new version in results[1].
    const insertResult = batchResults[1];
    const newVersion: number | null =
        insertResult?.results?.[0]?.version ?? null;

    // ── Invalidate pricing cache so the new value is visible immediately ────
    const pricingEngine = createPricingEngine(c.env.DB);
    pricingEngine.invalidateCache();

    return c.json({ rule_key, new_version: newVersion });
});

export default api;

// ─── POST /admin/billing/domains ──────────────────────────────────────────────
// Body: { domain: string, is_active?: boolean }
// Adds or updates allowed domain after optional Cloudflare Email Routing check.
// Requirements: 13.5
api.post('/admin/billing/domains', async (c) => {
    const msgs = i18n.getMessagesbyContext(c);
    let body: { domain?: string; is_active?: boolean };
    try {
        body = await c.req.json();
    } catch {
        return c.json({ error: 'invalid_input', message: msgs.InvalidInputMsg }, 400);
    }
    const domain = (body.domain || '').trim().toLowerCase();
    if (!domain) {
        return c.json({ error: 'invalid_input', message: msgs.RequiredFieldMsg }, 400);
    }

    // Optional CF validation step: when token exists, call CF Email Routing API.
    // In tests we mock this fetch and assert insertion only happens after success.
    const token = c.env.CLOUDFLARE_EMAIL_ROUTING_TOKEN;
    if (token) {
        const accountId = (c.env as unknown as Record<string, string>).CLOUDFLARE_ACCOUNT_ID || '';
        const zoneId = (c.env as unknown as Record<string, string>).CLOUDFLARE_ZONE_ID || '';
        const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/zones/${zoneId}/email/routing/addresses`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ email: `test@${domain}` }),
        });
        if (!res.ok) {
            return c.json({ error: 'operation_failed', message: msgs.OperationFailedMsg }, 400);
        }
    }

    await c.env.DB.prepare(
        `INSERT INTO allowed_domains (domain, is_active, created_at, created_by)
         VALUES (?, ?, CURRENT_TIMESTAMP, ?)
         ON CONFLICT(domain) DO UPDATE SET is_active = excluded.is_active`,
    )
        .bind(domain, body.is_active === false ? 0 : 1, getAdminIdForAudit(c))
        .run();

    return c.json({ domain, is_active: body.is_active === false ? 0 : 1 });
});
