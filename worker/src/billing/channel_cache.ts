/**
 * Channel_Cache — caches DompetX payment channels in D1 with a 10-minute TTL.
 * Implements stale-while-revalidate: returns cached data immediately and
 * schedules a background refresh via ctx.waitUntil when data is stale.
 *
 * Feature: saas-topup-billing
 * Requirements: 4.2, 4.4, 9.1, 16.2, 16.3, 16.4, 16.5
 */

import type { PaymentChannel, PaymentChannelQuote } from '../models/billing';

// ─── DompetX client interface (subset used by Channel_Cache) ─────────────────

export interface DompetxChannelClient {
    listChannels(): Promise<DompetxChannel[]>;
}

/**
 * Raw channel shape returned by DompetX API.
 * May contain sensitive fields that must be stripped before returning to callers.
 */
export interface DompetxChannel {
    channel_code: string;
    name: string;
    group?: string;
    min: number;
    max?: number | null;
    fee_type: 'percentage' | 'fixed' | 'mixed';
    fee_value: number;
    fee_fixed: number;
    fee_bearer: 'customer' | 'merchant';
    is_active: boolean;
    icon_url?: string;
    // Sensitive fields — stripped before returning to callers
    api_key?: string;
    signature_secret?: string;
    raw?: unknown;
    [key: string]: unknown;
}

// ─── ChannelCache interface ───────────────────────────────────────────────────

export interface ChannelCache {
    /**
     * Returns public channel list (no fee/gross computation).
     * If nominal is provided, filters to channels where:
     *   is_active = true AND nominal >= channel.min AND (channel.max IS NULL OR nominal <= channel.max)
     * If nominal is omitted, returns all active channels.
     *
     * Uses stale-while-revalidate: returns cached data and schedules background
     * refresh via ctx.waitUntil when data is stale (> 10 minutes old).
     */
    listPublic(nominal?: number, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<PaymentChannel[]>;

    /**
     * Returns channels eligible for the given nominal, with estimated_fee and gross_amount.
     * Filters same as listPublic(nominal).
     *
     * Fee computation:
     *   percentage: estimated_fee = floor(nominal * fee_value / 100)
     *   fixed:      estimated_fee = fee_fixed
     *   mixed:      estimated_fee = floor(nominal * fee_value / 100) + fee_fixed
     *
     * gross_amount = nominal + estimated_fee  iff fee_bearer = 'customer'
     * gross_amount = nominal                  iff fee_bearer = 'merchant'
     */
    listForQuote(nominal: number, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<PaymentChannelQuote[]>;

    /**
     * Force-refresh the cache by calling DompetX listChannels and rewriting
     * payment_channels_cache in one db.batch (DELETE + INSERT).
     * Returns the count of channels written.
     */
    refresh(): Promise<{ count: number }>;
}

// ─── TTL constant ─────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ─── Fee computation (pure function, exported for testing) ────────────────────

/**
 * Computes the estimated fee for a given channel and nominal amount.
 * - percentage: floor(nominal * fee_value / 100)
 * - fixed:      fee_fixed
 * - mixed:      floor(nominal * fee_value / 100) + fee_fixed
 */
export function computeFee(
    channel: Pick<PaymentChannel, 'fee_type' | 'fee_value' | 'fee_fixed'>,
    nominal: number,
): number {
    switch (channel.fee_type) {
        case 'percentage':
            return Math.floor((nominal * channel.fee_value) / 100);
        case 'fixed':
            return channel.fee_fixed;
        case 'mixed':
            return Math.floor((nominal * channel.fee_value) / 100) + channel.fee_fixed;
        default:
            return 0;
    }
}

// ─── Strip sensitive fields ───────────────────────────────────────────────────

const SENSITIVE_FIELDS = new Set(['api_key', 'signature_secret', 'raw']);

function stripSensitiveFields(channel: DompetxChannel): PaymentChannel {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(channel)) {
        if (!SENSITIVE_FIELDS.has(key)) {
            result[key] = value;
        }
    }
    return {
        channel_code: result.channel_code as string,
        name: result.name as string,
        group: (result.group as string) ?? '',
        min: result.min as number,
        max: (result.max as number | null) ?? null,
        fee_type: result.fee_type as 'percentage' | 'fixed' | 'mixed',
        fee_value: (result.fee_value as number) ?? 0,
        fee_fixed: (result.fee_fixed as number) ?? 0,
        fee_bearer: result.fee_bearer as 'customer' | 'merchant',
        is_active: Boolean(result.is_active),
        icon_url: result.icon_url as string | undefined,
    };
}

// ─── D1 row type ──────────────────────────────────────────────────────────────

interface ChannelCacheRow {
    channel_code: string;
    name: string;
    group: string | null;
    min: number;
    max: number | null;
    fee_type: 'percentage' | 'fixed' | 'mixed';
    fee_value: number;
    fee_fixed: number;
    fee_bearer: 'customer' | 'merchant';
    is_active: number; // SQLite stores as 0/1
    icon_url: string | null;
    fetched_at: string;
}

function rowToChannel(row: ChannelCacheRow): PaymentChannel {
    return {
        channel_code: row.channel_code,
        name: row.name,
        group: row.group ?? '',
        min: row.min,
        max: row.max,
        fee_type: row.fee_type,
        fee_value: row.fee_value,
        fee_fixed: row.fee_fixed,
        fee_bearer: row.fee_bearer,
        is_active: row.is_active === 1,
        icon_url: row.icon_url ?? undefined,
    };
}

// ─── Channel_Cache implementation ─────────────────────────────────────────────

export class Channel_Cache implements ChannelCache {
    private readonly db: D1Database;
    private readonly dompetx: DompetxChannelClient;

    /**
     * In-memory staleness tracker: maps nominal (or 'all' for no-nominal) to
     * the timestamp when the cache was last confirmed fresh.
     * This is a per-isolate optimisation — the authoritative freshness check
     * is the `fetched_at` column in D1.
     */
    private lastFetchedAt: Date | null = null;

    constructor(db: D1Database, dompetx: DompetxChannelClient) {
        this.db = db;
        this.dompetx = dompetx;
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    /**
     * Checks whether the cached data is stale by reading the most recent
     * `fetched_at` from D1. Returns true if stale (or no data exists).
     */
    private async isStale(): Promise<boolean> {
        // Fast path: use in-memory timestamp if available
        if (this.lastFetchedAt !== null) {
            return Date.now() - this.lastFetchedAt.getTime() > CACHE_TTL_MS;
        }
        // Slow path: query D1
        const row = await this.db
            .prepare(`SELECT fetched_at FROM payment_channels_cache ORDER BY fetched_at DESC LIMIT 1`)
            .first<{ fetched_at: string }>();
        if (!row) return true;
        const fetchedAt = new Date(row.fetched_at);
        this.lastFetchedAt = fetchedAt;
        return Date.now() - fetchedAt.getTime() > CACHE_TTL_MS;
    }

    /**
     * Schedules a background refresh if the cache is stale.
     * Uses ctx.waitUntil so the response is not delayed.
     */
    private scheduleRefreshIfStale(ctx?: { waitUntil(p: Promise<unknown>): void }): void {
        if (!ctx) return;
        ctx.waitUntil(
            this.isStale().then((stale) => {
                if (stale) return this.refresh();
            }),
        );
    }

    /**
     * Reads all active channels from D1, optionally filtered by nominal.
     */
    private async readFromDb(nominal?: number): Promise<PaymentChannel[]> {
        let query: string;
        let params: unknown[];

        if (nominal !== undefined) {
            query = `
                SELECT *
                FROM payment_channels_cache
                WHERE is_active = 1
                  AND ? >= min
                  AND (max IS NULL OR ? <= max)
                ORDER BY channel_code
            `;
            params = [nominal, nominal];
        } else {
            query = `
                SELECT *
                FROM payment_channels_cache
                WHERE is_active = 1
                ORDER BY channel_code
            `;
            params = [];
        }

        const stmt = this.db.prepare(query);
        const bound = params.length > 0 ? stmt.bind(...params) : stmt;
        const result = await bound.all<ChannelCacheRow>();
        return (result.results ?? []).map(rowToChannel);
    }

    // ── Public API ───────────────────────────────────────────────────────────

    async listPublic(
        nominal?: number,
        ctx?: { waitUntil(p: Promise<unknown>): void },
    ): Promise<PaymentChannel[]> {
        // Schedule background refresh if stale (stale-while-revalidate)
        this.scheduleRefreshIfStale(ctx);
        return this.readFromDb(nominal);
    }

    async listForQuote(
        nominal: number,
        ctx?: { waitUntil(p: Promise<unknown>): void },
    ): Promise<PaymentChannelQuote[]> {
        // Schedule background refresh if stale (stale-while-revalidate)
        this.scheduleRefreshIfStale(ctx);

        const channels = await this.readFromDb(nominal);

        return channels.map((ch): PaymentChannelQuote => {
            const estimated_fee = computeFee(ch, nominal);
            const gross_amount =
                ch.fee_bearer === 'customer' ? nominal + estimated_fee : nominal;
            return {
                ...ch,
                estimated_fee,
                gross_amount,
            };
        });
    }

    async refresh(): Promise<{ count: number }> {
        // Fetch fresh channel list from DompetX
        const rawChannels = await this.dompetx.listChannels();

        // Strip sensitive fields from each channel
        const channels = rawChannels.map(stripSensitiveFields);

        const now = new Date().toISOString();

        // Build D1 batch: DELETE all existing rows, then INSERT fresh rows
        const deleteStmt = this.db.prepare(`DELETE FROM payment_channels_cache`);

        const insertStmts = channels.map((ch) =>
            this.db
                .prepare(
                    `INSERT INTO payment_channels_cache
                     (channel_code, name, "group", min, max, fee_type, fee_value, fee_fixed,
                      fee_bearer, is_active, icon_url, fetched_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .bind(
                    ch.channel_code,
                    ch.name,
                    ch.group ?? null,
                    ch.min,
                    ch.max ?? null,
                    ch.fee_type,
                    ch.fee_value,
                    ch.fee_fixed,
                    ch.fee_bearer,
                    ch.is_active ? 1 : 0,
                    ch.icon_url ?? null,
                    now,
                ),
        );

        // Execute as a single batch (atomic delete + reinsert)
        await this.db.batch([deleteStmt, ...insertStmts]);

        // Update in-memory staleness tracker
        this.lastFetchedAt = new Date(now);

        return { count: channels.length };
    }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates a Channel_Cache instance.
 * @param db - D1 database binding
 * @param dompetx - DompetX client (or mock for testing)
 */
export function createChannelCache(
    db: D1Database,
    dompetx: DompetxChannelClient,
): ChannelCache {
    return new Channel_Cache(db, dompetx);
}
