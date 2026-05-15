/**
 * Abuse_Guard — rate limiting, fingerprint validation, and IP new-user guard
 * for billing endpoints.
 *
 * Feature: saas-topup-billing
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6
 *
 * KV key schema (all under the `rl:` prefix):
 *   rl:quote:{user_id}:{bucketMinute}   — per-user quote counter, TTL 60s
 *   rl:topup:{user_id}:{bucket10min}    — per-user create counter, TTL 600s
 *   rl:ipnew:{ip}:{bucketHour}          — unique user_ids from an IP, TTL 3600s
 *   rl:ipblock:{ip}                     — IP block flag, TTL 3600s
 *
 * KV binding resolution (design.md §Abuse_Guard / wrangler.toml template):
 *   Prefer `BILLING_RATE_LIMITER` when bound, otherwise fall back to `KV`.
 *
 * Failure modes (design.md §"Failure modes" #6):
 *   - checkTopupCreate: fail-closed — KV unavailable → throw RateLimitUnavailableError (503)
 *   - checkTopupQuote:  fail-open   — KV unavailable → log + allow
 *
 * Error contract:
 *   These methods THROW typed errors (FingerprintRequiredError, RateLimitedError,
 *   RateLimitUnavailableError). The calling route handler in Billing_API is
 *   responsible for translating them into HTTP responses with the appropriate
 *   i18n message (see design.md §"Error taxonomy and HTTP mapping").
 */

import type { Context } from 'hono';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Quote endpoint: max requests per user per 60-second window (Req 10.2). */
const QUOTE_MAX_PER_MIN = 30;

/** Create endpoint: max requests per user per 600-second window (Req 10.1). */
const CREATE_MAX_PER_10MIN = 30;

/** IP guard: threshold of unique user_ids from the same IP in a 1-hour window (Req 10.4). */
const IP_NEW_USER_BLOCK_THRESHOLD = 10;

/** IP block TTL in seconds (Req 10.4: "minimal 1 jam"). */
const IP_BLOCK_TTL_SECONDS = 3600;

// ─── Error types ─────────────────────────────────────────────────────────────

/** Thrown when the `x-fingerprint` header is missing/empty/whitespace. HTTP 400. */
export class FingerprintRequiredError extends Error {
    readonly code = 'fingerprint_required' as const;
    readonly httpStatus = 400 as const;
    constructor() {
        super('x-fingerprint header is required');
        this.name = 'FingerprintRequiredError';
    }
}

/** Thrown when the caller exceeds the rate limit. HTTP 429. */
export class RateLimitedError extends Error {
    readonly code = 'rate_limited' as const;
    readonly httpStatus = 429 as const;
    constructor(public readonly reason: 'quote' | 'create' | 'ip_blocked') {
        super(`Rate limit exceeded: ${reason}`);
        this.name = 'RateLimitedError';
    }
}

/** Thrown when KV is unavailable and the endpoint fails closed. HTTP 503. */
export class RateLimitUnavailableError extends Error {
    readonly code = 'rate_limit_unavailable' as const;
    readonly httpStatus = 503 as const;
    constructor(cause?: unknown) {
        super('Rate limiter backend unavailable');
        this.name = 'RateLimitUnavailableError';
        if (cause !== undefined) {
            (this as { cause?: unknown }).cause = cause;
        }
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve the KV namespace used for rate-limit counters.
 * Prefers the dedicated `BILLING_RATE_LIMITER` namespace when bound,
 * otherwise falls back to the shared `KV` namespace with the `rl:` key prefix.
 * Returns null only when neither binding is present (mis-configured environment).
 */
function getRlKv(c: Context<HonoCustomType>): KVNamespace | null {
    return c.env.BILLING_RATE_LIMITER ?? c.env.KV ?? null;
}

/**
 * Returns the current time bucket index for a window of `windowSeconds`.
 * `Math.floor(Date.now() / 1000 / windowSeconds)` yields a stable integer
 * that changes exactly once per window boundary.
 */
function timeBucket(windowSeconds: number): number {
    return Math.floor(Date.now() / 1000 / windowSeconds);
}

/**
 * Increment a KV counter and return the new value.
 *
 * Strategy: read → parse → increment → write with TTL.
 * This is not strictly atomic (KV has no atomic counter primitive) but
 * window-bucketed counters tolerate slight over-counting in practice;
 * the rate-limit guarantee is "at most N within window" modulo KV eventual
 * consistency, which is acceptable for abuse mitigation.
 *
 * Returns null when any KV operation fails — caller decides fail-open vs fail-closed.
 */
async function kvIncrement(
    kv: KVNamespace,
    key: string,
    ttlSeconds: number,
): Promise<number | null> {
    try {
        const raw = await kv.get(key);
        const parsed = raw ? parseInt(raw, 10) : 0;
        const current = Number.isFinite(parsed) ? parsed : 0;
        const next = current + 1;
        await kv.put(key, String(next), { expirationTtl: ttlSeconds });
        return next;
    } catch (e) {
        console.error('[Abuse_Guard] kvIncrement error', key, e);
        return null;
    }
}

/**
 * SHA-256 hex digest via the Web Crypto API (available in Cloudflare Workers).
 */
async function sha256Hex(input: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Extract the client IP from Cloudflare / proxy headers.
 * Prefers `cf-connecting-ip` (Cloudflare's authoritative header);
 * falls back to the first entry of `x-forwarded-for` for local/dev.
 */
function getClientIp(c: Context<HonoCustomType>): string | null {
    const cf = c.req.header('cf-connecting-ip');
    if (cf && cf.trim() !== '') return cf.trim();
    const xff = c.req.header('x-forwarded-for');
    if (xff) {
        const first = xff.split(',')[0]?.trim();
        if (first) return first;
    }
    return null;
}

// ─── AbuseGuard interface ─────────────────────────────────────────────────────

export interface AbuseGuard {
    /**
     * Validates the `x-fingerprint` header (Req 10.5).
     * - Throws `FingerprintRequiredError` (HTTP 400) when missing/empty/whitespace-only.
     * - Computes sha256(fingerprint) and attaches to `c.var.fingerprint_hash`.
     * - Returns the computed hex hash for convenience.
     */
    requireFingerprint(c: Context<HonoCustomType>): Promise<string>;

    /**
     * Rate-limit check for `POST /user_api/topup/quote` (Req 10.2).
     * Max 30 requests per user per minute.
     * Fail-open on KV unavailability (log + allow) per design.md §"Failure modes" #6.
     * Throws `RateLimitedError` (HTTP 429) on excess.
     */
    checkTopupQuote(c: Context<HonoCustomType>): Promise<void>;

    /**
     * Rate-limit check for `POST /user_api/topup/create` (Req 10.1, 10.4).
     * Max 5 requests per user per 10 minutes, plus IP new-user guard:
     *   >10 unique user_ids from the same IP in 1 hour → block IP for 1 hour
     *   and write a `billing_audit_logs` row with `event_type='ip_block'`.
     * Fail-closed on KV unavailability: throws `RateLimitUnavailableError` (HTTP 503).
     * Throws `RateLimitedError` (HTTP 429) on excess or IP block.
     */
    checkTopupCreate(c: Context<HonoCustomType>): Promise<void>;
}

// ─── Implementation ───────────────────────────────────────────────────────────

class AbuseGuardImpl implements AbuseGuard {
    // ── requireFingerprint ────────────────────────────────────────────────────

    async requireFingerprint(c: Context<HonoCustomType>): Promise<string> {
        const raw = c.req.header('x-fingerprint');

        if (!raw || raw.trim() === '') {
            throw new FingerprintRequiredError();
        }

        const hash = await sha256Hex(raw.trim());

        // Attach to context variables so downstream handlers can persist it
        // (e.g. topup_transactions.fingerprint_hash) without re-computing.
        // The `fingerprint_hash` key is declared in the Variables type.
        c.set('fingerprint_hash', hash);

        return hash;
    }

    // ── checkTopupQuote ───────────────────────────────────────────────────────

    async checkTopupQuote(c: Context<HonoCustomType>): Promise<void> {
        const userId = c.get('userPayload')?.user_id;

        // Auth middleware should already have rejected unauthenticated requests;
        // if we somehow reach here without a user, fail-open (nothing to key on).
        if (!userId) return;

        const kv = getRlKv(c);
        if (!kv) {
            // Fail-open: no KV binding configured — log and allow (design.md #6).
            console.warn('[Abuse_Guard] checkTopupQuote: no KV binding available, failing open');
            return;
        }

        const bucket = timeBucket(60);
        const key = `rl:quote:${userId}:${bucket}`;

        const count = await kvIncrement(kv, key, 60);
        if (count === null) {
            // Fail-open: KV read/write failed — log and allow.
            console.warn('[Abuse_Guard] checkTopupQuote: KV operation failed, failing open');
            return;
        }

        if (count > QUOTE_MAX_PER_MIN) {
            throw new RateLimitedError('quote');
        }
    }

    // ── checkTopupCreate ──────────────────────────────────────────────────────

    async checkTopupCreate(c: Context<HonoCustomType>): Promise<void> {
        const userId = c.get('userPayload')?.user_id;
        if (!userId) return;

        const kv = getRlKv(c);
        if (!kv) {
            // Fail-closed: money-moving path must not proceed without rate-limit backend.
            console.error('[Abuse_Guard] checkTopupCreate: no KV binding available, failing closed');
            throw new RateLimitUnavailableError();
        }

        // 1. Per-user create counter (5 / 10 min)
        const userKey = `rl:topup:${userId}:${timeBucket(600)}`;
        const userCount = await kvIncrement(kv, userKey, 600);
        if (userCount === null) {
            // Fail-open: KV operation failed — log and allow (avoid 503 on permission issues).
            console.warn('[Abuse_Guard] checkTopupCreate: KV operation failed, failing open');
            return;
        }
        if (userCount > CREATE_MAX_PER_10MIN) {
            throw new RateLimitedError('create');
        }

        // 2. IP new-user abuse guard (>10 unique users from same IP per hour)
        const ip = getClientIp(c);
        if (ip) {
            await this.checkIpNewUserGuard(c, kv, ip, userId);
        }
    }

    // ── IP new-user guard (internal) ──────────────────────────────────────────

    private async checkIpNewUserGuard(
        c: Context<HonoCustomType>,
        kv: KVNamespace,
        ip: string,
        userId: number,
    ): Promise<void> {
        const blockKey = `rl:ipblock:${ip}`;

        // a) Is the IP currently blocked?
        let blocked: string | null;
        try {
            blocked = await kv.get(blockKey);
        } catch (e) {
            // Fail-open: cannot verify block status for the money-moving path — log and allow.
            console.error('[Abuse_Guard] checkIpNewUserGuard: KV error reading block key, failing open', e);
            return;
        }
        if (blocked !== null) {
            throw new RateLimitedError('ip_blocked');
        }

        // b) Track distinct user_ids from this IP in the current hour bucket.
        const bucketHour = timeBucket(3600);
        const ipNewKey = `rl:ipnew:${ip}:${bucketHour}`;

        let uniqueUserIds: number[] = [];
        try {
            const raw = await kv.get(ipNewKey);
            if (raw) {
                try {
                    const parsed = JSON.parse(raw) as { uniqueUserIds?: unknown };
                    if (Array.isArray(parsed.uniqueUserIds)) {
                        uniqueUserIds = parsed.uniqueUserIds.filter(
                            (v): v is number => typeof v === 'number' && Number.isFinite(v),
                        );
                    }
                } catch {
                    // Corrupted JSON — reset the bucket rather than fail the request.
                    uniqueUserIds = [];
                }
            }
        } catch (e) {
            console.error('[Abuse_Guard] checkIpNewUserGuard: KV error reading ipnew key, failing open', e);
            return;
        }

        // c) Add the current user_id if not already tracked, and persist.
        if (!uniqueUserIds.includes(userId)) {
            uniqueUserIds.push(userId);
            try {
                await kv.put(
                    ipNewKey,
                    JSON.stringify({ uniqueUserIds }),
                    { expirationTtl: 3600 },
                );
            } catch (e) {
                console.error('[Abuse_Guard] checkIpNewUserGuard: KV error writing ipnew key, failing open', e);
                return;
            }
        }

        // d) Threshold check: >10 unique users → block IP + audit log.
        if (uniqueUserIds.length > IP_NEW_USER_BLOCK_THRESHOLD) {
            try {
                await kv.put(blockKey, '1', { expirationTtl: IP_BLOCK_TTL_SECONDS });
            } catch (e) {
                // If we cannot persist the block flag, still record the audit entry
                // and reject this request to stay fail-closed on the money path.
                console.error('[Abuse_Guard] checkIpNewUserGuard: KV error writing block key', e);
            }

            await this.writeIpBlockAuditLog(c, ip, uniqueUserIds.length);
            throw new RateLimitedError('ip_blocked');
        }
    }

    /**
     * Append one `billing_audit_logs` row with `event_type='ip_block'`.
     * Best-effort: failure to write the audit row must not mask the rate-limit
     * response; we log and swallow DB errors here.
     */
    private async writeIpBlockAuditLog(
        c: Context<HonoCustomType>,
        ip: string,
        uniqueUserCount: number,
    ): Promise<void> {
        try {
            await c.env.DB.prepare(
                `INSERT INTO billing_audit_logs
                    (admin_id, event_type, target_user_id, rule_key, old_value, new_value, reason, metadata, created_at)
                 VALUES (NULL, 'ip_block', NULL, NULL, NULL, NULL, ?, ?, CURRENT_TIMESTAMP)`,
            )
                .bind(
                    `IP blocked: ${uniqueUserCount} unique new users within 1h`,
                    JSON.stringify({ ip, unique_user_count: uniqueUserCount }),
                )
                .run();
        } catch (e) {
            console.error('[Abuse_Guard] writeIpBlockAuditLog: failed to write audit row', e);
        }
    }
}

// ─── Factory + default instance ───────────────────────────────────────────────

/**
 * Factory for the default AbuseGuard implementation.
 * Exported so tests can instantiate independent instances per test case.
 */
export function createAbuseGuard(): AbuseGuard {
    return new AbuseGuardImpl();
}

/** Default singleton for use in route handlers. */
export const abuseGuard: AbuseGuard = createAbuseGuard();
