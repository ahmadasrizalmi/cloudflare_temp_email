// Feature: saas-topup-billing, Property 15: Channel filter correctness
/**
 * Property-based test for Channel_Cache channel-filter correctness.
 *
 * Property 15: Channel-filter correctness
 *   Every row returned by `listPublic(nominal)` and `listForQuote(nominal)`
 *   satisfies:
 *     is_active = 1
 *     AND (
 *       nominal === undefined
 *       OR (nominal >= min AND (max IS NULL OR nominal <= max))
 *     )
 *
 * Validates: Requirements 4.4, 16.2, 16.3, 19.5
 *
 * Note: listForQuote requires a defined nominal (number); listPublic is used
 * for the nominal===undefined branch.
 */

import fc from 'fast-check';
import BetterSqlite3, { type Database as BetterSqlite3Database } from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
    createChannelCache,
    type DompetxChannelClient,
} from '../channel_cache.js';

// ─── Minimal D1Database shim over better-sqlite3 ──────────────────────────────
//
// Channel_Cache uses only:
//   db.prepare(sql).bind(...params).all<T>()           → { results: T[] }
//   db.prepare(sql).first<T>()                         → T | null
//   db.batch([stmt, ...])                              → not exercised here
//       (test seeds rows directly via SQL rather than calling refresh())
//
// We model that minimal subset; anything unused is omitted.

interface FakeStatement {
    bind(...values: unknown[]): FakeStatement;
    all<T = unknown>(): Promise<{ results: T[] }>;
    first<T = unknown>(): Promise<T | null>;
}

function makeStatement(
    sqlite: BetterSqlite3Database,
    sql: string,
    boundValues: unknown[] = [],
): FakeStatement {
    return {
        bind(...values: unknown[]): FakeStatement {
            return makeStatement(sqlite, sql, [...boundValues, ...values]);
        },
        async all<T = unknown>(): Promise<{ results: T[] }> {
            const stmt = sqlite.prepare(sql);
            const rows = boundValues.length > 0
                ? stmt.all(...boundValues)
                : stmt.all();
            return { results: rows as T[] };
        },
        async first<T = unknown>(): Promise<T | null> {
            const stmt = sqlite.prepare(sql);
            const row = boundValues.length > 0
                ? stmt.get(...boundValues)
                : stmt.get();
            return (row ?? null) as T | null;
        },
    };
}

interface FakeD1 {
    prepare(sql: string): FakeStatement;
    batch(stmts: FakeStatement[]): Promise<unknown>;
}

function makeFakeD1(sqlite: BetterSqlite3Database): FakeD1 {
    return {
        prepare(sql: string): FakeStatement {
            return makeStatement(sqlite, sql);
        },
        // Not used by this test; provided for interface completeness.
        async batch(_stmts: FakeStatement[]): Promise<unknown[]> {
            return [];
        },
    };
}

// ─── Schema setup (only payment_channels_cache is needed) ─────────────────────

const SCHEMA_SQL = `
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
`;

// ─── Stub DompetX client (never called: test seeds D1 directly) ──────────────

const stubDompetxClient: DompetxChannelClient = {
    async listChannels() {
        throw new Error(
            'stubDompetxClient.listChannels should not be called in this test',
        );
    },
};

// ─── Fast-check generators ────────────────────────────────────────────────────

/** Arbitrary: integer min in [0..1_000_000], realistic for IDR nominal boundaries. */
const minValue = () => fc.integer({ min: 0, max: 1_000_000 });

/** Arbitrary: max is either NULL or an integer in [0..10_000_000]; allowed to be < min. */
const maxValue = () =>
    fc.option(fc.integer({ min: 0, max: 10_000_000 }), { nil: null });

/** Arbitrary: is_active flag. */
const isActiveFlag = () => fc.oneof(fc.constant(0), fc.constant(1));

/** Arbitrary: fee type. */
const feeType = () =>
    fc.constantFrom('percentage' as const, 'fixed' as const, 'mixed' as const);

/** Arbitrary: fee bearer. */
const feeBearer = () =>
    fc.constantFrom('customer' as const, 'merchant' as const);

interface ChannelRow {
    channel_code: string;
    name: string;
    group: string | null;
    min: number;
    max: number | null;
    fee_type: 'percentage' | 'fixed' | 'mixed';
    fee_value: number;
    fee_fixed: number;
    fee_bearer: 'customer' | 'merchant';
    is_active: 0 | 1;
    icon_url: string | null;
}

/** Arbitrary: a single cache row. channel_code is forced unique at the array level. */
const channelRowArb = () =>
    fc.record({
        min: minValue(),
        max: maxValue(),
        fee_type: feeType(),
        fee_value: fc.integer({ min: 0, max: 1000 }),
        fee_fixed: fc.integer({ min: 0, max: 100_000 }),
        fee_bearer: feeBearer(),
        is_active: isActiveFlag(),
    });

/**
 * Arbitrary: an array of rows with distinct channel_codes. We assign codes
 * deterministically after generation so uniqueness is guaranteed.
 */
const rowsArb = () =>
    fc.array(channelRowArb(), { minLength: 0, maxLength: 20 }).map((rows) =>
        rows.map((r, i): ChannelRow => ({
            channel_code: `CH_${i.toString().padStart(3, '0')}`,
            name: `Channel ${i}`,
            group: null,
            ...r,
            icon_url: null,
        })),
    );

/**
 * Arbitrary: nominal ∈ ℤ⁺ ∪ {undefined}. Using undefined lets us cover the
 * listPublic-without-nominal branch.
 */
const nominalArb = () =>
    fc.option(fc.integer({ min: 1, max: 10_000_000 }), {
        nil: undefined,
    });

// ─── Seeding helper ──────────────────────────────────────────────────────────

function seedRows(sqlite: BetterSqlite3Database, rows: ChannelRow[]): void {
    sqlite.exec('DELETE FROM payment_channels_cache');
    if (rows.length === 0) return;
    const insert = sqlite.prepare(`
        INSERT INTO payment_channels_cache
          (channel_code, name, "group", min, max, fee_type, fee_value, fee_fixed,
           fee_bearer, is_active, icon_url, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    const insertMany = sqlite.transaction((list: ChannelRow[]) => {
        for (const r of list) {
            insert.run(
                r.channel_code,
                r.name,
                r.group,
                r.min,
                r.max,
                r.fee_type,
                r.fee_value,
                r.fee_fixed,
                r.fee_bearer,
                r.is_active,
                r.icon_url,
            );
        }
    });
    insertMany(rows);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Channel_Cache — Property 15: Channel filter correctness', () => {
    let sqlite: BetterSqlite3Database;
    let db: FakeD1;

    beforeEach(() => {
        sqlite = new BetterSqlite3(':memory:');
        sqlite.exec(SCHEMA_SQL);
        db = makeFakeD1(sqlite);
    });

    afterEach(() => {
        sqlite.close();
    });

    /**
     * Property 15 (core invariant):
     *   For every row r returned by listPublic(nominal) / listForQuote(nominal):
     *     r.is_active === true
     *     AND (nominal === undefined
     *          OR (nominal >= r.min AND (r.max === null OR nominal <= r.max)))
     */
    it('every row returned by listPublic / listForQuote satisfies the filter invariant', async () => {
        await fc.assert(
            fc.asyncProperty(rowsArb(), nominalArb(), async (rows, nominal) => {
                seedRows(sqlite, rows);

                // Cast the shim to the D1Database type expected by the factory.
                // Only the subset used by Channel_Cache is exercised.
                const cache = createChannelCache(
                    db as unknown as D1Database,
                    stubDompetxClient,
                );

                // ── listPublic: supports nominal === undefined and nominal === number ──
                const publicResult = await cache.listPublic(nominal);
                for (const row of publicResult) {
                    expect(row.is_active).toBe(true);
                    if (nominal !== undefined) {
                        expect(nominal).toBeGreaterThanOrEqual(row.min);
                        if (row.max !== null) {
                            expect(nominal).toBeLessThanOrEqual(row.max);
                        }
                    }
                }

                // ── listForQuote: requires a defined numeric nominal ──
                if (nominal !== undefined) {
                    const quoteResult = await cache.listForQuote(nominal);
                    for (const row of quoteResult) {
                        expect(row.is_active).toBe(true);
                        expect(nominal).toBeGreaterThanOrEqual(row.min);
                        if (row.max !== null) {
                            expect(nominal).toBeLessThanOrEqual(row.max);
                        }
                    }

                    // Consistency: every quote row must appear in the public listing
                    // (same filter predicate, so same set of channel_codes).
                    const publicCodes = new Set(
                        publicResult.map((r) => r.channel_code),
                    );
                    for (const row of quoteResult) {
                        expect(publicCodes.has(row.channel_code)).toBe(true);
                    }
                }
            }),
            { numRuns: 100 },
        );
    });

    it('rejects inactive channels even when nominal is in range', async () => {
        // Concrete unit check of the invariant: a single inactive row in range
        // must never surface in either list.
        seedRows(sqlite, [
            {
                channel_code: 'INACTIVE_CH',
                name: 'Inactive',
                group: null,
                min: 10_000,
                max: 1_000_000,
                fee_type: 'fixed',
                fee_value: 0,
                fee_fixed: 0,
                fee_bearer: 'customer',
                is_active: 0,
                icon_url: null,
            },
        ]);

        const cache = createChannelCache(
            db as unknown as D1Database,
            stubDompetxClient,
        );

        expect(await cache.listPublic(50_000)).toEqual([]);
        expect(await cache.listPublic(undefined)).toEqual([]);
        expect(await cache.listForQuote(50_000)).toEqual([]);
    });

    it('respects open-ended max (NULL) by admitting any nominal >= min', async () => {
        seedRows(sqlite, [
            {
                channel_code: 'OPEN_MAX',
                name: 'Open max',
                group: null,
                min: 10_000,
                max: null,
                fee_type: 'fixed',
                fee_value: 0,
                fee_fixed: 0,
                fee_bearer: 'customer',
                is_active: 1,
                icon_url: null,
            },
        ]);

        const cache = createChannelCache(
            db as unknown as D1Database,
            stubDompetxClient,
        );

        // Below min: filtered out
        expect(await cache.listPublic(9_999)).toEqual([]);
        // At boundary: included
        expect((await cache.listPublic(10_000)).map((r) => r.channel_code)).toEqual([
            'OPEN_MAX',
        ]);
        // Well above: included (NULL max means no upper bound)
        expect(
            (await cache.listPublic(999_999_999)).map((r) => r.channel_code),
        ).toEqual(['OPEN_MAX']);
    });
});
