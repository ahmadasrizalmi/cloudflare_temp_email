// Feature: saas-topup-billing, Property 1: Ledger sum invariant
/**
 * Property-based test for the Wallet_Service ledger-sum invariant.
 *
 * Property 1: Ledger sum invariant
 *   For every user u, at every observable point in time:
 *     SUM(credit_ledger.credit_delta WHERE user_id = u) === wallets.balance_credit WHERE user_id = u
 *
 *   A model-based generator emits random command sequences drawn from
 *   { topup, bonus_topup, debit, refund, adjust } over a small pool of user
 *   ids. After every committed operation we assert the invariant for every
 *   user. Business-rule failures (InsufficientCreditError,
 *   NegativeBalanceError) are swallowed silently because rejected mutations
 *   must still preserve the invariant — they must neither mutate `wallets`
 *   nor `credit_ledger`.
 *
 * Validates: Requirements 3.4, 19.1
 */

import fc from 'fast-check';
import BetterSqlite3, { type Database as BetterSqlite3Database } from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
    createWalletService,
    InsufficientCreditError,
    NegativeBalanceError,
} from '../wallet_service.js';

// ─── Schema (minimum needed by Wallet_Service) ───────────────────────────────
//
// Mirrors db/2026-05-15-billing-wallet.sql (wallets + credit_ledger +
// idempotency unique index) plus the `users` parent table from db/schema.sql
// so the FK on wallets.user_id resolves. Defaults and CHECK constraints are
// kept verbatim so the service's SQL hits the same guards it would in D1.

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY,
  user_email TEXT UNIQUE NOT NULL,
  password   TEXT NOT NULL
);

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

CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_idem_type
  ON credit_ledger(idempotency_key, type)
  WHERE idempotency_key IS NOT NULL;
`;

// ─── Minimal D1Database shim over better-sqlite3 ─────────────────────────────
//
// Wallet_Service uses:
//   db.prepare(sql).bind(...p).run()     → D1Result (we surface meta.changes)
//   db.prepare(sql).bind(...p).first<T>()→ T | null
//   db.prepare(sql).bind(...p).all<T>()  → { results: T[]; meta }
//   db.batch<T>([stmt, ...])             → D1Result<T>[]
//
// Each batch runs inside a better-sqlite3 transaction so it is atomic and
// rolls back on any error (matching D1's batch semantics). Statements inside
// a batch share the connection's `changes()` state, which is essential for
// the `WHERE (SELECT changes()) > 0` gate used by `debit` and `adjust`.

interface FakeD1Result<T = Record<string, unknown>> {
    success: true;
    results: T[];
    meta: { changes: number; rows_written: number; duration: number };
}

interface FakePreparedStatement {
    bind(...values: unknown[]): FakePreparedStatement;
    run<T = Record<string, unknown>>(): Promise<FakeD1Result<T>>;
    first<T = unknown>(column?: string): Promise<T | null>;
    all<T = Record<string, unknown>>(): Promise<FakeD1Result<T>>;
    readonly __sql: string;
    readonly __params: unknown[];
}

/**
 * Execute one statement against the raw sqlite connection. Uses `.all()` for
 * statements that return rows (SELECT, INSERT/UPDATE ... RETURNING) and
 * `.run()` otherwise. Always reports the statement's `changes()` so batch
 * callers can inspect `meta.changes`.
 */
function runStatementOnce(
    sqlite: BetterSqlite3Database,
    sql: string,
    params: unknown[],
): { rows: Record<string, unknown>[]; changes: number } {
    const stmt = sqlite.prepare(sql);
    if (stmt.reader) {
        const rows = (params.length > 0
            ? stmt.all(...params)
            : stmt.all()) as Record<string, unknown>[];
        // `changes()` still reflects the last INSERT/UPDATE/DELETE, including
        // writes with a RETURNING clause that were just executed.
        const changes = sqlite
            .prepare('SELECT changes() AS c')
            .pluck()
            .get() as number;
        return { rows, changes: typeof changes === 'number' ? changes : 0 };
    }
    const info = params.length > 0 ? stmt.run(...params) : stmt.run();
    return { rows: [], changes: Number(info.changes ?? 0) };
}

function wrapResult<T>(rows: Record<string, unknown>[], changes: number): FakeD1Result<T> {
    return {
        success: true,
        results: rows as unknown as T[],
        meta: { changes, rows_written: changes, duration: 0 },
    };
}

function makePreparedStatement(
    sqlite: BetterSqlite3Database,
    sql: string,
    boundParams: unknown[] = [],
): FakePreparedStatement {
    return {
        __sql: sql,
        __params: boundParams,
        bind(...values: unknown[]): FakePreparedStatement {
            return makePreparedStatement(sqlite, sql, [...boundParams, ...values]);
        },
        async run<T = Record<string, unknown>>(): Promise<FakeD1Result<T>> {
            const { rows, changes } = runStatementOnce(sqlite, sql, boundParams);
            return wrapResult<T>(rows, changes);
        },
        async first<T = unknown>(column?: string): Promise<T | null> {
            const stmt = sqlite.prepare(sql);
            const row = (boundParams.length > 0
                ? stmt.get(...boundParams)
                : stmt.get()) as Record<string, unknown> | undefined;
            if (!row) return null;
            if (typeof column === 'string') {
                return (row[column] ?? null) as T | null;
            }
            return row as unknown as T;
        },
        async all<T = Record<string, unknown>>(): Promise<FakeD1Result<T>> {
            const { rows, changes } = runStatementOnce(sqlite, sql, boundParams);
            return wrapResult<T>(rows, changes);
        },
    };
}

interface FakeD1Database {
    prepare(sql: string): FakePreparedStatement;
    batch<T = Record<string, unknown>>(
        stmts: FakePreparedStatement[],
    ): Promise<FakeD1Result<T>[]>;
}

function makeFakeD1(sqlite: BetterSqlite3Database): FakeD1Database {
    return {
        prepare(sql: string): FakePreparedStatement {
            return makePreparedStatement(sqlite, sql);
        },
        async batch<T = Record<string, unknown>>(
            stmts: FakePreparedStatement[],
        ): Promise<FakeD1Result<T>[]> {
            // `sqlite.transaction(fn)` rolls back automatically when `fn`
            // throws, matching D1's "batch is atomic" contract. This is what
            // Wallet_Service relies on for the conditional UPDATE + gated
            // INSERT pattern and for unique-violation rollbacks on replay.
            const exec = sqlite.transaction((list: FakePreparedStatement[]) => {
                const out: FakeD1Result<T>[] = [];
                for (const s of list) {
                    const { rows, changes } = runStatementOnce(sqlite, s.__sql, s.__params);
                    out.push(wrapResult<T>(rows, changes));
                }
                return out;
            });
            return exec(stmts);
        },
    };
}

// ─── Command model ────────────────────────────────────────────────────────────

const USER_IDS = [1, 2, 3, 4] as const;

/** Fixed bonus/rate parameters; vary amountIdr to straddle the threshold. */
const CREDIT_IDR_RATE = 100;
const BONUS_THRESHOLD_IDR = 100_000;
const BONUS_RATE_PERCENT = 5;

type Cmd =
    | { kind: 'topup'; userId: number; amountIdr: number }
    | { kind: 'bonus_topup'; userId: number; amountIdr: number }
    | { kind: 'debit'; userId: number; credits: number }
    | { kind: 'refund'; userId: number; pickIdx: number }
    | { kind: 'adjust'; userId: number; delta: number };

const cmdArb = (): fc.Arbitrary<Cmd> =>
    fc.oneof(
        // topup below the bonus threshold → no bonus row
        fc.record({
            kind: fc.constant('topup' as const),
            userId: fc.constantFrom(...USER_IDS),
            amountIdr: fc.integer({ min: 10_000, max: BONUS_THRESHOLD_IDR - 1 }),
        }),
        // topup at/above the bonus threshold → BONUS ledger row also written
        fc.record({
            kind: fc.constant('bonus_topup' as const),
            userId: fc.constantFrom(...USER_IDS),
            amountIdr: fc.integer({ min: BONUS_THRESHOLD_IDR, max: 1_000_000 }),
        }),
        // debit (positive credits; may fail with InsufficientCreditError)
        fc.record({
            kind: fc.constant('debit' as const),
            userId: fc.constantFrom(...USER_IDS),
            credits: fc.integer({ min: 1, max: 80 }),
        }),
        // refund a prior debit by index (ignored if no prior debit exists)
        fc.record({
            kind: fc.constant('refund' as const),
            userId: fc.constantFrom(...USER_IDS),
            pickIdx: fc.integer({ min: 0, max: 1000 }),
        }),
        // adjust (+/-; zero is filtered out to match the CHECK constraint)
        fc.record({
            kind: fc.constant('adjust' as const),
            userId: fc.constantFrom(...USER_IDS),
            delta: fc
                .integer({ min: -60, max: 60 })
                .filter((v) => v !== 0),
        }),
    );

const commandSequenceArb = () =>
    fc.array(cmdArb(), { minLength: 1, maxLength: 40 });

// ─── Invariant check ──────────────────────────────────────────────────────────

function assertLedgerSumInvariant(
    sqlite: BetterSqlite3Database,
    userIds: readonly number[],
): void {
    const walletStmt = sqlite.prepare(
        `SELECT balance_credit FROM wallets WHERE user_id = ?`,
    );
    const ledgerSumStmt = sqlite
        .prepare(
            `SELECT COALESCE(SUM(credit_delta), 0) AS s FROM credit_ledger WHERE user_id = ?`,
        )
        .pluck();

    for (const uid of userIds) {
        const wallet = walletStmt.get(uid) as { balance_credit: number } | undefined;
        const balance = wallet?.balance_credit ?? 0;
        const ledgerSum = ledgerSumStmt.get(uid) as number;
        expect(ledgerSum).toBe(balance);
    }
}

// ─── Test ─────────────────────────────────────────────────────────────────────

describe('Wallet_Service — Property 1: Ledger sum invariant', () => {
    let sqlite: BetterSqlite3Database;

    beforeEach(() => {
        sqlite = new BetterSqlite3(':memory:');
        sqlite.pragma('foreign_keys = ON');
        sqlite.exec(SCHEMA_SQL);

        const insertUser = sqlite.prepare(
            `INSERT INTO users (id, user_email, password) VALUES (?, ?, ?)`,
        );
        for (const uid of USER_IDS) {
            insertUser.run(uid, `u${uid}@test.local`, 'x');
        }
    });

    afterEach(() => {
        sqlite.close();
    });

    it('SUM(credit_ledger.credit_delta) === wallets.balance_credit for every user after every committed op', async () => {
        await fc.assert(
            fc.asyncProperty(commandSequenceArb(), async (cmds) => {
                // Reset per-iteration state (keep the seeded users intact).
                sqlite.exec('DELETE FROM credit_ledger');
                sqlite.exec('DELETE FROM wallets');
                // Reset AUTOINCREMENT sequence for credit_ledger so ids are
                // stable across iterations (not strictly required for the
                // invariant; keeps assertions deterministic).
                sqlite
                    .prepare(`DELETE FROM sqlite_sequence WHERE name = ?`)
                    .run('credit_ledger');

                const db = makeFakeD1(sqlite);
                const service = createWalletService(
                    db as unknown as D1Database,
                );

                let invoiceCounter = 0;
                // Track successful DEBIT ledger ids per user so the `refund`
                // command can reference a real prior debit.
                const debitsByUser = new Map<
                    number,
                    { ledgerId: number; credits: number }[]
                >();

                for (const cmd of cmds) {
                    try {
                        switch (cmd.kind) {
                            case 'topup':
                            case 'bonus_topup': {
                                const invoiceId = `inv_${invoiceCounter++}`;
                                await service.creditTopup({
                                    userId: cmd.userId,
                                    amountIdr: cmd.amountIdr,
                                    creditIdrRate: CREDIT_IDR_RATE,
                                    bonusThresholdIdr: BONUS_THRESHOLD_IDR,
                                    bonusRatePercent: BONUS_RATE_PERCENT,
                                    invoiceId,
                                });
                                break;
                            }
                            case 'debit': {
                                const res = await service.debit({
                                    userId: cmd.userId,
                                    credits: cmd.credits,
                                    actionKey: 'create_address',
                                    domain: 'automation.my.id',
                                    resourceId: `r_${invoiceCounter++}`,
                                });
                                if (res.ledgerId > 0) {
                                    const list =
                                        debitsByUser.get(cmd.userId) ?? [];
                                    list.push({
                                        ledgerId: res.ledgerId,
                                        credits: cmd.credits,
                                    });
                                    debitsByUser.set(cmd.userId, list);
                                }
                                break;
                            }
                            case 'refund': {
                                const list = debitsByUser.get(cmd.userId);
                                if (!list || list.length === 0) break; // no prior debit
                                const pick = list[cmd.pickIdx % list.length];
                                await service.refund({
                                    userId: cmd.userId,
                                    credits: pick.credits,
                                    refundOfLedgerId: pick.ledgerId,
                                    reason: 'property-test',
                                });
                                break;
                            }
                            case 'adjust': {
                                await service.adjust({
                                    adminId: 999,
                                    userId: cmd.userId,
                                    creditDelta: cmd.delta,
                                    reason: 'property-test-adjust',
                                });
                                break;
                            }
                        }
                    } catch (err) {
                        // Expected business-rule rejections: they must not
                        // mutate either table, so the invariant still holds.
                        if (err instanceof InsufficientCreditError) continue;
                        if (err instanceof NegativeBalanceError) continue;
                        throw err;
                    }

                    // Invariant: SUM(ledger) == wallet.balance_credit per user,
                    // checked after every committed command.
                    assertLedgerSumInvariant(sqlite, USER_IDS);
                }
            }),
            { numRuns: 100 },
        );
    });
});
