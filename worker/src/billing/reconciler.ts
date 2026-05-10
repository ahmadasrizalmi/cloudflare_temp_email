/**
 * Topup_Reconciler — batched job that verifies the terminal state of
 * expired `pending` top-up transactions with DompetX and converges the local
 * state accordingly.
 *
 * Runs under the scheduled Worker (cron) every 5 minutes. See task 13.3 for
 * the wiring into `worker/src/scheduled.ts`; this file only exposes the pure
 * `runReconcile(env, ctx)` entry point so it is trivially unit-testable.
 *
 * Feature: saas-topup-billing
 * Requirements:
 *   - 8.3 — scheduled Worker runs every 5 minutes and marks pending rows
 *           older than `expiry_minutes` as expired
 *   - 8.4 — calls DompetX status API as final verification before flipping
 *           a row to `expired`
 *   - 8.5 — when DompetX says `paid`, trigger the same credit flow as the
 *           webhook (idempotent via `invoice_id`)
 */

import type { DompetxClient, InvoiceStatusResponse } from './dompetx_client';
import { DompetxError, createDompetxClient } from './dompetx_client';
import type { WalletService } from './wallet_service';
import { createWalletService } from './wallet_service';
import type { PricingEngine } from './pricing_engine';
import { createPricingEngine } from './pricing_engine';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Row shape used by the reconciler. We only project the columns we need.
 */
interface PendingTopupRow {
    id: number;
    user_id: number;
    invoice_id: string;
    amount: number;
    expiry_minutes: number;
}

/**
 * Summary of what the reconciler did in a single invocation.
 *
 * - `processed` — total rows fetched & inspected (includes rows that failed
 *   individually and rows left pending)
 * - `paid` / `failed` / `expired` — rows whose state was converged to the
 *   matching terminal status during this run
 */
export interface ReconcileSummary {
    processed: number;
    paid: number;
    failed: number;
    expired: number;
    marginAdjusted?: boolean;
}

/**
 * Optional dependencies for tests. In production, all four are built from
 * `env` / `env.DB` via the standard factories.
 */
export interface ReconcileDeps {
    dompetx?: DompetxClient;
    wallet?: WalletService;
    pricing?: PricingEngine;
    /** Injectable "now" for deterministic tests. Defaults to `Date.now()`. */
    now?: () => Date;
    /** Upper bound on rows scanned per invocation (default 100). */
    batchSize?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DEFAULT_BATCH_SIZE = 100;

function logInfo(msg: string, extra?: Record<string, unknown>): void {
    // Keep logs structured so Cloudflare Logs can parse them. Avoid logging
    // secrets — only identifiers and status codes.
    console.log(`[reconciler] ${msg}`, extra ?? '');
}

function logWarn(msg: string, extra?: Record<string, unknown>): void {
    console.warn(`[reconciler] ${msg}`, extra ?? '');
}

function logError(msg: string, err: unknown, extra?: Record<string, unknown>): void {
    console.error(
        `[reconciler] ${msg}`,
        extra ?? '',
        err instanceof Error ? { name: err.name, message: err.message } : err,
    );
}

/**
 * Fetch up to `limit` pending top-up rows whose `created_at` is older than
 * `expiry_minutes` minutes ago. The `datetime('now', '-' || expiry_minutes || ' minutes')`
 * expression runs fully server-side so each row is compared against its own
 * configured expiry (which may be customised per transaction).
 */
async function fetchExpiredPending(
    db: D1Database,
    limit: number,
): Promise<PendingTopupRow[]> {
    const { results } = await db
        .prepare(
            `SELECT id, user_id, invoice_id, amount, expiry_minutes
               FROM topup_transactions
              WHERE status = 'pending'
                AND created_at < datetime('now', '-' || expiry_minutes || ' minutes')
              ORDER BY created_at ASC
              LIMIT ?`,
        )
        .bind(limit)
        .all<PendingTopupRow>();
    return results ?? [];
}

/**
 * Conditional UPDATE — flips a pending row to a terminal status only if the
 * row is still `pending`. Returns true when a row was updated (i.e. we were
 * the racer that converged the state). Rows that already transitioned (e.g.
 * a webhook fired between the SELECT and the UPDATE) are safely ignored.
 */
async function transitionToTerminal(
    db: D1Database,
    invoiceId: string,
    newStatus: 'paid' | 'failed' | 'expired',
    paidAt: string | null,
): Promise<boolean> {
    if (newStatus === 'paid') {
        const res = await db
            .prepare(
                `UPDATE topup_transactions
                    SET status = 'paid',
                        paid_at = COALESCE(?, datetime('now')),
                        updated_at = datetime('now')
                  WHERE invoice_id = ?
                    AND status = 'pending'`,
            )
            .bind(paidAt, invoiceId)
            .run();
        return (res.meta?.changes ?? 0) > 0;
    }

    const res = await db
        .prepare(
            `UPDATE topup_transactions
                SET status = ?,
                    updated_at = datetime('now')
              WHERE invoice_id = ?
                AND status = 'pending'`,
        )
        .bind(newStatus, invoiceId)
        .run();
    return (res.meta?.changes ?? 0) > 0;
}

/**
 * Map a DompetX status into the bucket the reconciler acts on. Any status
 * that doesn't clearly indicate a terminal outcome (including `pending` and
 * `cancelled`) is treated as `unknown` — the row is left alone and will be
 * re-checked on the next cron tick.
 */
function mapProviderStatus(
    status: InvoiceStatusResponse['status'] | string,
): 'paid' | 'failed' | 'expired' | 'unknown' {
    if (status === 'paid') return 'paid';
    if (status === 'failed') return 'failed';
    if (status === 'expired') return 'expired';
    return 'unknown';
}

// ─── Core reconciliation for a single row ────────────────────────────────────

interface RowContext {
    dompetx: DompetxClient;
    wallet: WalletService;
    db: D1Database;
    pricing: {
        creditIdrRate: number;
        bonusThresholdIdr: number;
        bonusRatePercent: number;
    };
}

async function reconcileRow(
    row: PendingTopupRow,
    ctx: RowContext,
): Promise<'paid' | 'failed' | 'expired' | 'unknown'> {
    let providerStatus: InvoiceStatusResponse;
    try {
        providerStatus = await ctx.dompetx.getInvoiceStatus(row.invoice_id);
    } catch (err) {
        if (err instanceof DompetxError) {
            logWarn('getInvoiceStatus failed; leaving row pending', {
                invoice_id: row.invoice_id,
                code: err.code,
                httpStatus: err.httpStatus,
            });
        } else {
            logError('getInvoiceStatus threw unexpected error', err, {
                invoice_id: row.invoice_id,
            });
        }
        return 'unknown';
    }

    const mapped = mapProviderStatus(providerStatus.status);

    switch (mapped) {
        case 'paid': {
            // Credit first — `creditTopup` is idempotent by `invoice_id`, so
            // a concurrent webhook that already credited will no-op this call
            // and return the committed snapshot. We then flip the row status
            // guarded on `status='pending'`, which is safe: if the webhook
            // already flipped it, `changes()` will be 0 and we silently move
            // on.
            try {
                await ctx.wallet.creditTopup({
                    userId: row.user_id,
                    amountIdr: row.amount,
                    creditIdrRate: ctx.pricing.creditIdrRate,
                    bonusThresholdIdr: ctx.pricing.bonusThresholdIdr,
                    bonusRatePercent: ctx.pricing.bonusRatePercent,
                    invoiceId: row.invoice_id,
                });
            } catch (err) {
                logError('creditTopup failed', err, {
                    invoice_id: row.invoice_id,
                    user_id: row.user_id,
                });
                // Leave the row pending; the next tick will retry. We never
                // flip `status='paid'` without a successful credit.
                return 'unknown';
            }

            const updated = await transitionToTerminal(
                ctx.db,
                row.invoice_id,
                'paid',
                providerStatus.paid_at ?? null,
            );
            if (updated) {
                logInfo('converged to paid', { invoice_id: row.invoice_id });
            }
            // Whether we or the webhook performed the flip, the observable
            // state is `paid` and the credit ledger has the TOPUP row — count
            // this invocation as a successful paid reconciliation.
            return 'paid';
        }

        case 'failed': {
            const updated = await transitionToTerminal(
                ctx.db,
                row.invoice_id,
                'failed',
                null,
            );
            if (updated) {
                logInfo('converged to failed', { invoice_id: row.invoice_id });
            }
            return 'failed';
        }

        case 'expired': {
            const updated = await transitionToTerminal(
                ctx.db,
                row.invoice_id,
                'expired',
                null,
            );
            if (updated) {
                logInfo('converged to expired', { invoice_id: row.invoice_id });
            }
            return 'expired';
        }

        case 'unknown':
        default: {
            logInfo('provider returned non-terminal status; leaving pending', {
                invoice_id: row.invoice_id,
                provider_status: providerStatus.status,
            });
            return 'unknown';
        }
    }
}

async function maybeApplyAutoMarginGuard(
    db: D1Database,
    pricing: PricingEngine,
): Promise<boolean> {
    const [autoEnabledRaw, targetPercent, currentWeight] = await Promise.all([
        pricing.getObject<boolean>('margin_guard_auto'),
        pricing.getNumber('margin_guard_target_percent'),
        pricing.getNumber('domain_weight_com'),
    ]);
    const autoEnabled = Boolean(autoEnabledRaw);
    if (!autoEnabled || currentWeight >= 5) return false;

    const topup = await db.prepare(
        `SELECT COALESCE(SUM(amount), 0) AS total_topup
           FROM topup_transactions
          WHERE status = 'paid'
            AND created_at >= datetime('now', '-30 days')`,
    ).first<{ total_topup: number }>();
    const debitCost = await db.prepare(
        `SELECT COALESCE(SUM(idr_ref), 0) AS total_debit_idr
           FROM credit_ledger
          WHERE type = 'DEBIT'
            AND created_at >= datetime('now', '-30 days')`,
    ).first<{ total_debit_idr: number }>();

    const totalTopup = Number(topup?.total_topup ?? 0);
    const totalDebitIdr = Number(debitCost?.total_debit_idr ?? 0);
    if (totalTopup <= 0) return false;

    const netMarginPercent = ((totalTopup - totalDebitIdr) / totalTopup) * 100;
    if (netMarginPercent >= targetPercent) return false;

    const nextWeight = Math.min(5, currentWeight + 1);
    if (nextWeight === currentWeight) return false;

    await db.batch([
        db.prepare(
            `UPDATE pricing_rules
                SET is_active = 0
              WHERE rule_key = 'domain_weight_com' AND is_active = 1`,
        ),
        db.prepare(
            `INSERT INTO pricing_rules (rule_key, rule_value_json, version, is_active)
             VALUES (
               'domain_weight_com',
               ?,
               (SELECT COALESCE(MAX(version), 0) + 1 FROM pricing_rules WHERE rule_key = 'domain_weight_com'),
               1
             )`,
        ).bind(JSON.stringify(nextWeight)),
        db.prepare(
            `INSERT INTO billing_audit_logs
               (admin_id, event_type, target_user_id, rule_key, old_value, new_value, reason, metadata, created_at)
             VALUES (NULL, 'auto_margin_guard', NULL, 'domain_weight_com', ?, ?, NULL, ?, CURRENT_TIMESTAMP)`,
        ).bind(
            JSON.stringify(currentWeight),
            JSON.stringify(nextWeight),
            JSON.stringify({
                net_margin_monthly: netMarginPercent,
                margin_guard_target_percent: targetPercent,
            }),
        ),
    ]);

    pricing.invalidateCache();
    return true;
}

// ─── Public entry point ──────────────────────────────────────────────────────

/**
 * Reconcile expired pending top-ups against the DompetX status API.
 *
 * Behaviour:
 * 1. Fetch up to `batchSize` (default 100) rows from `topup_transactions`
 *    where `status = 'pending'` and `created_at < now - expiry_minutes`.
 * 2. Read `credit_idr_rate`, `bonus_threshold_idr`, `bonus_rate_percent`
 *    from the Pricing_Engine once, before iterating, so per-row calls hit
 *    the 60-second cache rather than D1.
 * 3. For each row, call `DompetxClient.getInvoiceStatus(invoice_id)` and
 *    converge the local state:
 *      - `paid`   → invoke `Wallet_Service.creditTopup` (idempotent via
 *                   `invoice_id`) and flip the row to `status='paid'` (gated
 *                   on `status='pending'` so a concurrent webhook wins the
 *                   race without side effects).
 *      - `failed` / `expired` → flip the row to the matching terminal status
 *        (also gated on `status='pending'`).
 *      - anything else → leave the row pending; the next cron tick retries.
 * 4. Individual row failures (D1 errors, DompetX outages, credit failures)
 *    are caught and logged per-row and never abort the batch.
 *
 * Note: the auto margin guard (task 13.2) and scheduled.ts wiring (task
 * 13.3) are intentionally NOT implemented here — this function is exported
 * in isolation so task 13.2 can call it and task 13.3 can wire it.
 */
export async function runReconcile(
    env: Bindings,
    ctx?: ExecutionContext,
    deps?: ReconcileDeps,
): Promise<ReconcileSummary> {
    // `ctx` is accepted for future use (e.g. `ctx.waitUntil` for non-blocking
    // bookkeeping) so callers from `scheduled()` can pass it through; the
    // reference below keeps the linter quiet when ctx is unused in this build.
    void ctx;

    const db = env.DB;
    const batchSize = deps?.batchSize ?? DEFAULT_BATCH_SIZE;

    // Build collaborators via factories so tests can swap them in `deps`.
    const dompetx: DompetxClient = deps?.dompetx ?? createDompetxClient(env);
    const wallet: WalletService = deps?.wallet ?? createWalletService(db);
    const pricing: PricingEngine = deps?.pricing ?? createPricingEngine(db);

    const summary: ReconcileSummary = {
        processed: 0,
        paid: 0,
        failed: 0,
        expired: 0,
        marginAdjusted: false,
    };

    // Fetch the batch first so a DB failure here surfaces clearly — there is
    // no point pre-reading pricing if we have nothing to reconcile.
    let rows: PendingTopupRow[];
    try {
        rows = await fetchExpiredPending(db, batchSize);
    } catch (err) {
        logError('failed to fetch expired pending rows', err);
        return summary;
    }

    if (rows.length === 0) {
        logInfo('no expired pending rows to reconcile');
        return summary;
    }

    // Pre-resolve pricing once so every row uses the same snapshot. These
    // reads hit the engine's 60-second cache, but pulling them out of the
    // loop also avoids repeating error handling per row.
    let creditIdrRate: number;
    let bonusThresholdIdr: number;
    let bonusRatePercent: number;
    try {
        [creditIdrRate, bonusThresholdIdr, bonusRatePercent] = await Promise.all([
            pricing.getNumber('credit_idr_rate'),
            pricing.getNumber('bonus_threshold_idr'),
            pricing.getNumber('bonus_rate_percent'),
        ]);
    } catch (err) {
        // Without pricing we cannot credit; bail out without mutating any row.
        logError('failed to resolve pricing rules; skipping reconcile batch', err, {
            batch_rows: rows.length,
        });
        return summary;
    }

    const rowCtx: RowContext = {
        dompetx,
        wallet,
        db,
        pricing: { creditIdrRate, bonusThresholdIdr, bonusRatePercent },
    };

    logInfo('starting reconcile batch', {
        rows: rows.length,
        credit_idr_rate: creditIdrRate,
        bonus_threshold_idr: bonusThresholdIdr,
        bonus_rate_percent: bonusRatePercent,
    });

    for (const row of rows) {
        summary.processed++;
        try {
            const outcome = await reconcileRow(row, rowCtx);
            if (outcome === 'paid') summary.paid++;
            else if (outcome === 'failed') summary.failed++;
            else if (outcome === 'expired') summary.expired++;
            // 'unknown' intentionally contributes to `processed` only — the
            // row stays pending and will be retried on the next tick.
        } catch (err) {
            // Defence in depth: reconcileRow already catches its own errors,
            // but any unexpected throw must not abort the batch.
            logError('unexpected error reconciling row', err, {
                invoice_id: row.invoice_id,
            });
        }
    }

    try {
        summary.marginAdjusted = await maybeApplyAutoMarginGuard(db, pricing);
    } catch (err) {
        logError('auto margin guard evaluation failed', err);
    }

    logInfo('reconcile batch complete', { ...summary });
    return summary;
}
