/**
 * Wallet_Service — internal service for credit wallet management.
 * Feature: saas-topup-billing
 * Requirements: 1.2, 1.3, 3.1, 3.2, 3.3, 3.4, 3.6, 5.4, 6.2, 6.3, 6.4, 6.6, 6.7,
 *               9.3, 9.4, 11.1, 11.2, 11.3, 11.6
 */

import type { WalletRow, LedgerEntry, LedgerPage, LedgerMetadata } from '../models/billing';

// ─── Error types ─────────────────────────────────────────────────────────────

export class InsufficientCreditError extends Error {
    readonly code = 'insufficient_credit' as const;
    constructor() {
        super('Insufficient credit balance');
        this.name = 'InsufficientCreditError';
    }
}

export class NegativeBalanceError extends Error {
    readonly code = 'negative_balance_not_allowed' as const;
    constructor() {
        super('Resulting balance would be negative');
        this.name = 'NegativeBalanceError';
    }
}

// ─── WalletService interface ──────────────────────────────────────────────────

export interface WalletService {
    /** Lazy-create wallet if missing. Returns current snapshot. */
    ensureWallet(userId: number): Promise<WalletRow>;

    /** Read current wallet snapshot (throws if wallet does not exist). */
    getSnapshot(userId: number): Promise<WalletRow>;

    /**
     * Paginated ledger list ordered by created_at DESC.
     * limit is capped at 100. cursor is an opaque base64 string encoding (created_at, id).
     */
    listLedger(args: { userId: number; limit: number; cursor?: string }): Promise<LedgerPage>;

    /**
     * Atomic debit: check balance >= credits, decrement, append DEBIT ledger in one D1 batch.
     * Throws InsufficientCreditError when rows_affected == 0.
     */
    debit(args: {
        userId: number;
        credits: number;
        actionKey: string;
        domain: string;
        resourceId?: string | number;
        idempotencyKey?: string;
    }): Promise<{ ledgerId: number; newBalance: number }>;

    /**
     * Compensating ledger for a prior DEBIT; +credits.
     * Idempotent by refund_of_ledger_id (idempotency_key = 'refund:' + refundOfLedgerId).
     */
    refund(args: {
        userId: number;
        credits: number;
        refundOfLedgerId: number;
        reason: string;
    }): Promise<{ ledgerId: number; newBalance: number }>;

    /**
     * Credit for paid topup + optional bonus, all in one D1 batch.
     * Idempotent by invoiceId. If already credited, no-op — re-reads and returns snapshot.
     */
    creditTopup(args: {
        userId: number;
        amountIdr: number;
        creditIdrRate: number;
        bonusThresholdIdr: number;
        bonusRatePercent: number;
        invoiceId: string;
    }): Promise<{ topupLedgerId: number; bonusLedgerId?: number; newBalance: number }>;

    /**
     * Admin-driven manual adjust. ADJUST ledger type.
     * Rejects if resulting balance < 0 before writing any row.
     */
    adjust(args: {
        adminId: number;
        userId: number;
        creditDelta: number;
        reason: string;
    }): Promise<{ ledgerId: number; newBalance: number }>;
}

// ─── Cursor helpers ───────────────────────────────────────────────────────────

interface CursorPayload {
    created_at: string;
    id: number;
}

function encodeCursor(created_at: string, id: number): string {
    const payload: CursorPayload = { created_at, id };
    return btoa(JSON.stringify(payload));
}

function decodeCursor(cursor: string): CursorPayload | null {
    try {
        const decoded = atob(cursor);
        const payload = JSON.parse(decoded) as CursorPayload;
        if (typeof payload.created_at !== 'string' || typeof payload.id !== 'number') {
            return null;
        }
        return payload;
    } catch {
        return null;
    }
}

// ─── D1 error detection ──────────────────────────────────────────────────────

function isUniqueViolation(err: unknown): boolean {
    if (err instanceof Error) {
        const msg = err.message.toLowerCase();
        return (
            msg.includes('unique') &&
            (msg.includes('constraint') ||
                msg.includes('sqlite_constraint') ||
                msg.includes('violation'))
        );
    }
    return false;
}

function isCheckViolation(err: unknown): boolean {
    if (err instanceof Error) {
        const msg = err.message.toLowerCase();
        return (
            msg.includes('check') &&
            (msg.includes('constraint') ||
                msg.includes('sqlite_constraint') ||
                msg.includes('failed'))
        );
    }
    return false;
}

// ─── D1 result helpers ────────────────────────────────────────────────────────

/**
 * Extract the first `id` column from a batch statement's results array.
 * Returns 0 when the RETURNING clause produced no rows (e.g. INSERT ... SELECT
 * with a WHERE gate that evaluated to false).
 */
function firstReturnedId(result: D1Result<Record<string, unknown>> | undefined): number {
    if (!result || !result.results || result.results.length === 0) return 0;
    const row = result.results[0];
    const id = row.id;
    return typeof id === 'number' ? id : 0;
}

/** Number of rows changed by the given batch statement (0 if unavailable). */
function rowsChanged<T>(result: D1Result<T> | undefined): number {
    if (!result) return 0;
    const meta = result.meta as { changes?: number; rows_written?: number } | undefined;
    return meta?.changes ?? meta?.rows_written ?? 0;
}

// ─── Implementation ───────────────────────────────────────────────────────────

export class WalletServiceImpl implements WalletService {
    constructor(private readonly db: D1Database) {}

    // ── ensureWallet ──────────────────────────────────────────────────────────

    async ensureWallet(userId: number): Promise<WalletRow> {
        // INSERT OR IGNORE so repeated calls are idempotent (no extra row when
        // the wallet already exists).
        await this.db
            .prepare(
                `INSERT OR IGNORE INTO wallets (user_id, balance_credit, balance_idr_ref, created_at, updated_at)
                 VALUES (?, 0, 0, datetime('now'), datetime('now'))`
            )
            .bind(userId)
            .run();

        return this.getSnapshot(userId);
    }

    // ── getSnapshot ───────────────────────────────────────────────────────────

    async getSnapshot(userId: number): Promise<WalletRow> {
        const row = await this.db
            .prepare(`SELECT * FROM wallets WHERE user_id = ?`)
            .bind(userId)
            .first<WalletRow>();

        if (!row) {
            throw new Error(`Wallet not found for user ${userId}`);
        }
        return row;
    }

    // ── listLedger ────────────────────────────────────────────────────────────

    async listLedger(args: { userId: number; limit: number; cursor?: string }): Promise<LedgerPage> {
        // Enforce server-side cap of 100 per page (requirement 3.2).
        const requested = Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : 20;
        const limit = Math.min(requested, 100);

        let query: string;
        let bindings: (string | number)[];

        if (args.cursor) {
            const parsed = decodeCursor(args.cursor);
            if (!parsed) {
                throw new Error('Invalid cursor');
            }
            // Stable keyset pagination: rows strictly older than the cursor
            // position. Ties on created_at are broken by id DESC so pages
            // never overlap and never skip rows.
            query = `
                SELECT * FROM credit_ledger
                WHERE user_id = ?
                  AND (created_at < ? OR (created_at = ? AND id < ?))
                ORDER BY created_at DESC, id DESC
                LIMIT ?
            `;
            bindings = [args.userId, parsed.created_at, parsed.created_at, parsed.id, limit + 1];
        } else {
            query = `
                SELECT * FROM credit_ledger
                WHERE user_id = ?
                ORDER BY created_at DESC, id DESC
                LIMIT ?
            `;
            bindings = [args.userId, limit + 1];
        }

        const stmt = this.db.prepare(query);
        const { results } = await stmt.bind(...bindings).all<Record<string, unknown>>();

        const hasMore = results.length > limit;
        const items = (hasMore ? results.slice(0, limit) : results).map((row) =>
            this.mapLedgerRow(row)
        );

        let next_cursor: string | null = null;
        if (hasMore && items.length > 0) {
            const last = items[items.length - 1];
            next_cursor = encodeCursor(last.created_at, last.id);
        }

        return { items, next_cursor };
    }

    // ── debit ─────────────────────────────────────────────────────────────────

    async debit(args: {
        userId: number;
        credits: number;
        actionKey: string;
        domain: string;
        resourceId?: string | number;
        idempotencyKey?: string;
    }): Promise<{ ledgerId: number; newBalance: number }> {
        if (!Number.isInteger(args.credits) || args.credits <= 0) {
            throw new Error(`debit.credits must be a positive integer (got ${args.credits})`);
        }

        const metadata: LedgerMetadata = {
            action_key: args.actionKey,
            domain: args.domain,
            resource_id: args.resourceId,
        };
        const metadataJson = JSON.stringify(metadata);

        // Three-statement atomic batch:
        //   1. ensure wallet exists (INSERT OR IGNORE — no-op if already present)
        //   2. conditional UPDATE that only succeeds when balance >= credits
        //   3. INSERT DEBIT ledger gated on UPDATE having actually changed a row
        //      via `WHERE (SELECT changes()) > 0`. If the UPDATE's WHERE guard
        //      excluded the row, changes() == 0 and this INSERT inserts nothing,
        //      preserving the ledger-sum invariant (Property 1).
        const ensureStmt = this.db
            .prepare(
                `INSERT OR IGNORE INTO wallets (user_id, balance_credit, balance_idr_ref, created_at, updated_at)
                 VALUES (?, 0, 0, datetime('now'), datetime('now'))`
            )
            .bind(args.userId);

        const updateStmt = this.db
            .prepare(
                `UPDATE wallets
                   SET balance_credit = balance_credit - ?,
                       updated_at = datetime('now')
                 WHERE user_id = ? AND balance_credit >= ?
                 RETURNING balance_credit`
            )
            .bind(args.credits, args.userId, args.credits);

        const insertStmt = this.db
            .prepare(
                `INSERT INTO credit_ledger
                   (user_id, type, credit_delta, metadata, idempotency_key, created_at)
                 SELECT ?, 'DEBIT', ?, ?, ?, datetime('now')
                 WHERE (SELECT changes()) > 0
                 RETURNING id`
            )
            .bind(args.userId, -args.credits, metadataJson, args.idempotencyKey ?? null);

        let results: D1Result<Record<string, unknown>>[];
        try {
            results = await this.db.batch<Record<string, unknown>>([
                ensureStmt,
                updateStmt,
                insertStmt,
            ]);
        } catch (err) {
            if (isCheckViolation(err)) {
                // CHECK (balance_credit >= 0) fired — treat as insufficient credit.
                throw new InsufficientCreditError();
            }
            throw err;
        }

        const [, updateRes, insertRes] = results;

        // If the UPDATE affected 0 rows, the INSERT WHERE-gate blocked the
        // ledger write — reject the request with InsufficientCreditError. No
        // mutation has been persisted.
        if (rowsChanged(updateRes) === 0) {
            throw new InsufficientCreditError();
        }

        const updatedBalance = this.extractBalanceFromResult(updateRes);
        const ledgerId = firstReturnedId(insertRes);

        // Fall back to a fresh read if RETURNING didn't surface the balance
        // (older D1 versions). This path should be rare.
        const newBalance =
            updatedBalance ?? (await this.readBalance(args.userId));

        return { ledgerId, newBalance };
    }

    // ── refund ────────────────────────────────────────────────────────────────

    async refund(args: {
        userId: number;
        credits: number;
        refundOfLedgerId: number;
        reason: string;
    }): Promise<{ ledgerId: number; newBalance: number }> {
        if (!Number.isInteger(args.credits) || args.credits <= 0) {
            throw new Error(`refund.credits must be a positive integer (got ${args.credits})`);
        }

        const idempotencyKey = `refund:${args.refundOfLedgerId}`;
        const metadata: LedgerMetadata = {
            refund_of: args.refundOfLedgerId,
            reason: args.reason,
        };
        const metadataJson = JSON.stringify(metadata);

        const ensureStmt = this.db
            .prepare(
                `INSERT OR IGNORE INTO wallets (user_id, balance_credit, balance_idr_ref, created_at, updated_at)
                 VALUES (?, 0, 0, datetime('now'), datetime('now'))`
            )
            .bind(args.userId);

        const updateStmt = this.db
            .prepare(
                `UPDATE wallets
                   SET balance_credit = balance_credit + ?,
                       updated_at = datetime('now')
                 WHERE user_id = ?
                 RETURNING balance_credit`
            )
            .bind(args.credits, args.userId);

        const insertStmt = this.db
            .prepare(
                `INSERT INTO credit_ledger
                   (user_id, type, credit_delta, metadata, idempotency_key, created_at)
                 VALUES (?, 'REFUND', ?, ?, ?, datetime('now'))
                 RETURNING id`
            )
            .bind(args.userId, args.credits, metadataJson, idempotencyKey);

        try {
            const results = await this.db.batch<Record<string, unknown>>([
                ensureStmt,
                updateStmt,
                insertStmt,
            ]);
            const [, updateRes, insertRes] = results;
            const ledgerId = firstReturnedId(insertRes);
            const balanceFromUpdate = this.extractBalanceFromResult(updateRes);
            const newBalance =
                balanceFromUpdate ?? (await this.readBalance(args.userId));
            return { ledgerId, newBalance };
        } catch (err) {
            if (isUniqueViolation(err)) {
                // Already refunded — batch rolled back (UPDATE reverted).
                // Read the existing REFUND ledger row and current balance.
                const existing = await this.db
                    .prepare(
                        `SELECT id FROM credit_ledger
                         WHERE idempotency_key = ? AND type = 'REFUND'`
                    )
                    .bind(idempotencyKey)
                    .first<{ id: number }>();

                const newBalance = await this.readBalance(args.userId);
                return { ledgerId: existing?.id ?? 0, newBalance };
            }
            throw err;
        }
    }

    // ── creditTopup ───────────────────────────────────────────────────────────

    async creditTopup(args: {
        userId: number;
        amountIdr: number;
        creditIdrRate: number;
        bonusThresholdIdr: number;
        bonusRatePercent: number;
        invoiceId: string;
    }): Promise<{ topupLedgerId: number; bonusLedgerId?: number; newBalance: number }> {
        if (args.creditIdrRate <= 0) {
            throw new Error(
                `creditTopup.creditIdrRate must be positive (got ${args.creditIdrRate})`
            );
        }
        if (args.amountIdr <= 0) {
            throw new Error(
                `creditTopup.amountIdr must be positive (got ${args.amountIdr})`
            );
        }

        const topupCredits = Math.floor(args.amountIdr / args.creditIdrRate);
        if (topupCredits <= 0) {
            // Guarded by min_topup_idr upstream; defensive rejection here.
            throw new Error(
                `creditTopup would write zero credits (amountIdr=${args.amountIdr}, creditIdrRate=${args.creditIdrRate})`
            );
        }

        const hasBonus = args.amountIdr >= args.bonusThresholdIdr;
        const bonusCredits = hasBonus
            ? Math.floor((args.amountIdr * args.bonusRatePercent) / 100 / args.creditIdrRate)
            : 0;

        // BONUS ledger requires credit_delta > 0 (CHECK constraint). Skip the
        // BONUS insert when the formula rounds down to 0 — the TOPUP still
        // commits, and the user paid for the credits but the bonus is simply
        // below 1 credit (nothing to record).
        const writeBonus = hasBonus && bonusCredits > 0;
        const totalCredits = topupCredits + (writeBonus ? bonusCredits : 0);

        const topupMetadata: LedgerMetadata = { invoice_id: args.invoiceId };
        const bonusMetadata: LedgerMetadata = { invoice_id: args.invoiceId };

        const ensureStmt = this.db
            .prepare(
                `INSERT OR IGNORE INTO wallets (user_id, balance_credit, balance_idr_ref, created_at, updated_at)
                 VALUES (?, 0, 0, datetime('now'), datetime('now'))`
            )
            .bind(args.userId);

        const updateStmt = this.db
            .prepare(
                `UPDATE wallets
                   SET balance_credit  = balance_credit  + ?,
                       balance_idr_ref = balance_idr_ref + ?,
                       updated_at      = datetime('now')
                 WHERE user_id = ?
                 RETURNING balance_credit`
            )
            .bind(totalCredits, args.amountIdr, args.userId);

        const insertTopupStmt = this.db
            .prepare(
                `INSERT INTO credit_ledger
                   (user_id, type, credit_delta, idr_ref, metadata, idempotency_key, created_at)
                 VALUES (?, 'TOPUP', ?, ?, ?, ?, datetime('now'))
                 RETURNING id`
            )
            .bind(
                args.userId,
                topupCredits,
                args.amountIdr,
                JSON.stringify(topupMetadata),
                args.invoiceId
            );

        const stmts: D1PreparedStatement[] = [ensureStmt, updateStmt, insertTopupStmt];

        if (writeBonus) {
            const insertBonusStmt = this.db
                .prepare(
                    `INSERT INTO credit_ledger
                       (user_id, type, credit_delta, idr_ref, metadata, idempotency_key, created_at)
                     VALUES (?, 'BONUS', ?, ?, ?, ?, datetime('now'))
                     RETURNING id`
                )
                .bind(
                    args.userId,
                    bonusCredits,
                    args.amountIdr,
                    JSON.stringify(bonusMetadata),
                    args.invoiceId
                );
            stmts.push(insertBonusStmt);
        }

        try {
            const results = await this.db.batch<Record<string, unknown>>(stmts);
            // results[0] = ensure, [1] = update, [2] = topup insert, [3]? = bonus insert
            const topupLedgerId = firstReturnedId(results[2]);
            const bonusLedgerId = writeBonus ? firstReturnedId(results[3]) : undefined;
            const balanceFromUpdate = this.extractBalanceFromResult(results[1]);
            const newBalance =
                balanceFromUpdate ?? (await this.readBalance(args.userId));
            return { topupLedgerId, bonusLedgerId, newBalance };
        } catch (err) {
            if (isUniqueViolation(err)) {
                // Replay: batch rolled back. Read the previously-written rows
                // so caller sees the committed state as a no-op.
                return this.readTopupResult(args.userId, args.invoiceId);
            }
            throw err;
        }
    }

    private async readTopupResult(
        userId: number,
        invoiceId: string
    ): Promise<{ topupLedgerId: number; bonusLedgerId?: number; newBalance: number }> {
        const topupRow = await this.db
            .prepare(
                `SELECT id FROM credit_ledger
                 WHERE idempotency_key = ? AND type = 'TOPUP' AND user_id = ?`
            )
            .bind(invoiceId, userId)
            .first<{ id: number }>();

        const bonusRow = await this.db
            .prepare(
                `SELECT id FROM credit_ledger
                 WHERE idempotency_key = ? AND type = 'BONUS' AND user_id = ?`
            )
            .bind(invoiceId, userId)
            .first<{ id: number }>();

        const newBalance = await this.readBalance(userId);

        return {
            topupLedgerId: topupRow?.id ?? 0,
            bonusLedgerId: bonusRow?.id ?? undefined,
            newBalance,
        };
    }

    // ── adjust ────────────────────────────────────────────────────────────────

    async adjust(args: {
        adminId: number;
        userId: number;
        creditDelta: number;
        reason: string;
    }): Promise<{ ledgerId: number; newBalance: number }> {
        if (!Number.isInteger(args.creditDelta) || args.creditDelta === 0) {
            // CHECK (type='ADJUST' AND credit_delta != 0)
            throw new Error(
                `adjust.creditDelta must be a non-zero integer (got ${args.creditDelta})`
            );
        }

        const metadata: LedgerMetadata = {
            admin_id: args.adminId,
            reason: args.reason,
        };
        const metadataJson = JSON.stringify(metadata);

        // Ensure wallet exists; for negative deltas, enforce balance guard in
        // the UPDATE itself so the CHECK constraint and the WHERE clause both
        // agree. For positive deltas, a plain UPDATE is fine.
        const ensureStmt = this.db
            .prepare(
                `INSERT OR IGNORE INTO wallets (user_id, balance_credit, balance_idr_ref, created_at, updated_at)
                 VALUES (?, 0, 0, datetime('now'), datetime('now'))`
            )
            .bind(args.userId);

        let updateStmt: D1PreparedStatement;
        if (args.creditDelta < 0) {
            // Guard: balance_credit >= |delta|. If insufficient, UPDATE affects
            // 0 rows and we short-circuit with NegativeBalanceError.
            updateStmt = this.db
                .prepare(
                    `UPDATE wallets
                       SET balance_credit = balance_credit + ?,
                           updated_at     = datetime('now')
                     WHERE user_id = ? AND balance_credit >= ?
                     RETURNING balance_credit`
                )
                .bind(args.creditDelta, args.userId, -args.creditDelta);
        } else {
            updateStmt = this.db
                .prepare(
                    `UPDATE wallets
                       SET balance_credit = balance_credit + ?,
                           updated_at     = datetime('now')
                     WHERE user_id = ?
                     RETURNING balance_credit`
                )
                .bind(args.creditDelta, args.userId);
        }

        const insertStmt = this.db
            .prepare(
                `INSERT INTO credit_ledger
                   (user_id, type, credit_delta, metadata, created_at)
                 SELECT ?, 'ADJUST', ?, ?, datetime('now')
                 WHERE (SELECT changes()) > 0
                 RETURNING id`
            )
            .bind(args.userId, args.creditDelta, metadataJson);

        let results: D1Result<Record<string, unknown>>[];
        try {
            results = await this.db.batch<Record<string, unknown>>([
                ensureStmt,
                updateStmt,
                insertStmt,
            ]);
        } catch (err) {
            if (isCheckViolation(err)) {
                throw new NegativeBalanceError();
            }
            throw err;
        }

        const [, updateRes, insertRes] = results;

        // For negative deltas, 0 rows changed means the guard rejected —
        // surface NegativeBalanceError without side effects.
        if (args.creditDelta < 0 && rowsChanged(updateRes) === 0) {
            throw new NegativeBalanceError();
        }

        const ledgerId = firstReturnedId(insertRes);
        const balanceFromUpdate = this.extractBalanceFromResult(updateRes);
        const newBalance = balanceFromUpdate ?? (await this.readBalance(args.userId));

        return { ledgerId, newBalance };
    }

    // ── private helpers ───────────────────────────────────────────────────────

    private async readBalance(userId: number): Promise<number> {
        const row = await this.db
            .prepare(`SELECT balance_credit FROM wallets WHERE user_id = ?`)
            .bind(userId)
            .first<{ balance_credit: number }>();
        return row?.balance_credit ?? 0;
    }

    private extractBalanceFromResult(
        result: D1Result<Record<string, unknown>> | undefined
    ): number | null {
        if (!result || !result.results || result.results.length === 0) return null;
        const row = result.results[0];
        const bal = row.balance_credit;
        return typeof bal === 'number' ? bal : null;
    }

    private mapLedgerRow(row: Record<string, unknown>): LedgerEntry {
        let metadata: LedgerMetadata | null = null;
        if (typeof row.metadata === 'string' && row.metadata) {
            try {
                metadata = JSON.parse(row.metadata) as LedgerMetadata;
            } catch {
                metadata = null;
            }
        }

        return {
            id: row.id as number,
            user_id: row.user_id as number,
            type: row.type as LedgerEntry['type'],
            credit_delta: row.credit_delta as number,
            idr_ref: (row.idr_ref as number | null) ?? null,
            metadata,
            idempotency_key: (row.idempotency_key as string | null) ?? null,
            created_at: row.created_at as string,
        };
    }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a WalletService instance bound to the given D1 database.
 * Inject a compatible D1Database adapter in tests.
 */
export function createWalletService(db: D1Database): WalletService {
    return new WalletServiceImpl(db);
}
