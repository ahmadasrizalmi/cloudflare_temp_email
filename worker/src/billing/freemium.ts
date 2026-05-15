/**
 * Freemium quota helpers for paid_action.ts.
 * Feature: saas-freemium
 *
 * Provides:
 *   - getFreemiumEmailLimit(db) — reads 'freemium_email_limit' from pricing_rules, defaults to 1
 *   - checkAndIncrementFreeQuota(db, userId, limit) — atomically consumes a free slot
 */

/**
 * Get freemium email limit from pricing_rules table.
 * Defaults to 1 if the rule row is missing.
 */
export async function getFreemiumEmailLimit(db: D1Database): Promise<number> {
    try {
        const row = await db
            .prepare(
                `SELECT rule_value_json FROM pricing_rules
                 WHERE rule_key = 'freemium_email_limit' AND is_active = 1
                 ORDER BY version DESC LIMIT 1`,
            )
            .first<{ rule_value_json: string }>();
        if (!row) return 1;
        const val = JSON.parse(row.rule_value_json);
        return typeof val === 'number' && val >= 0 ? val : 1;
    } catch {
        return 1;
    }
}

/**
 * Atomically check if the user still has free quota remaining and consume
 * one slot if so.
 *
 * Strategy:
 *   1. INSERT OR IGNORE to ensure the row exists (email_used = 0).
 *   2. UPDATE gated on email_used < limit. RETURNING tells us whether the
 *      row was actually changed.
 *
 * Returns true  → free slot was consumed (create the address for free).
 * Returns false → quota exhausted (proceed to paid billing).
 */
export async function checkAndIncrementFreeQuota(
    db: D1Database,
    userId: number,
    limit: number,
): Promise<boolean> {
    // Ensure row exists
    await db
        .prepare(
            `INSERT OR IGNORE INTO user_free_quota
               (user_id, email_used, created_at, updated_at)
             VALUES (?, 0, datetime('now'), datetime('now'))`,
        )
        .bind(userId)
        .run();

    // Atomic conditional increment
    const result = await db
        .prepare(
            `UPDATE user_free_quota
                SET email_used = email_used + 1,
                    updated_at = datetime('now')
              WHERE user_id = ? AND email_used < ?
              RETURNING email_used`,
        )
        .bind(userId, limit)
        .first<{ email_used: number }>();

    // If result is null the WHERE gate blocked the update -- quota exhausted
    return result !== null && result !== undefined;
}

/**
 * Read the current free email usage for a user (for display purposes).
 * Returns { used, limit } — both 0 if no row exists yet.
 */
export async function getFreeQuotaStatus(
    db: D1Database,
    userId: number,
): Promise<{ used: number; limit: number }> {
    const [limitVal, row] = await Promise.all([
        getFreemiumEmailLimit(db),
        db
            .prepare(`SELECT email_used FROM user_free_quota WHERE user_id = ?`)
            .bind(userId)
            .first<{ email_used: number }>(),
    ]);
    return { used: row?.email_used ?? 0, limit: limitVal };
}
