/**
 * Pricing_Engine — resolves credit cost for paid actions and exposes typed
 * accessors for all `pricing_rules` rows. All reads go through a module-level
 * cache with a 60-second TTL; admin PUTs invalidate the cache via
 * `invalidateCache()`.
 *
 * Feature: saas-topup-billing
 * Requirements: 2.2, 2.4, 6.1, 6.5, 7.2, 7.3, 7.7, 13.2
 *
 * Resolution algorithm (design.md §"Pricing_Engine"):
 *   suffix = extractSuffix(domain)              // e.g. ".com" | ".my.id" | ".web.id"
 *   isCom  = suffix === ".com"
 *   weight = isCom ? domain_weight_com : domain_weight_default
 *   switch (actionKey):
 *     create_address → weight * action_cost_create_address
 *     send_mail      → action_cost_send_mail       (constant, NOT weighted)
 *     forward_mail   → action_cost_forward_mail    (constant, NOT weighted)
 *     default        → throw UnknownActionError
 *
 * Read strategy: only the row with `is_active = 1 AND MAX(version)` per
 * `rule_key` is used, via `ORDER BY version DESC LIMIT 1`.
 */

import type { RuleKey } from '../models/billing';

// ─── Error types ─────────────────────────────────────────────────────────────

export class UnknownActionError extends Error {
    readonly code = 'unknown_action' as const;
    readonly actionKey: string;
    constructor(actionKey: string) {
        super(`Unknown action: ${actionKey}`);
        this.name = 'UnknownActionError';
        this.actionKey = actionKey;
    }
}

export class PricingRuleNotFoundError extends Error {
    readonly code = 'pricing_rule_not_found' as const;
    readonly ruleKey: string;
    constructor(ruleKey: string) {
        super(`Pricing rule not found or inactive: ${ruleKey}`);
        this.name = 'PricingRuleNotFoundError';
        this.ruleKey = ruleKey;
    }
}

// ─── Module-level cache (60s TTL) ────────────────────────────────────────────

/**
 * Cache entry holds the JSON-parsed value and an expiry timestamp (ms since
 * epoch). Stored as `unknown` because values are heterogeneous across rule
 * keys (number | boolean | object).
 */
interface CacheEntry {
    value: unknown;
    expiresAt: number;
}

const CACHE_TTL_MS = 60_000;

/**
 * Module-level cache, shared across all Pricing_Engine instances within the
 * same isolate. Per design.md: admin updates propagate within 60 seconds via
 * TTL expiry, or immediately via `invalidateCache()`.
 */
const moduleCache = new Map<string, CacheEntry>();

function cacheGet(ruleKey: string): unknown | undefined {
    const entry = moduleCache.get(ruleKey);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
        moduleCache.delete(ruleKey);
        return undefined;
    }
    return entry.value;
}

function cacheSet(ruleKey: string, value: unknown): void {
    moduleCache.set(ruleKey, {
        value,
        expiresAt: Date.now() + CACHE_TTL_MS,
    });
}

// ─── Domain suffix extraction ────────────────────────────────────────────────

/**
 * Extracts the domain suffix starting at the first dot.
 *   "sarapanbakery.com"  → ".com"
 *   "automation.my.id"   → ".my.id"
 *   "jagoseo.web.id"     → ".web.id"
 *   "localhost"          → ""      (no dot)
 *
 * Exported for property-based tests which compute the expected value as a
 * pure oracle.
 */
export function extractSuffix(domain: string): string {
    const i = domain.indexOf('.');
    return i === -1 ? '' : domain.slice(i);
}

// ─── PricingEngine interface ─────────────────────────────────────────────────

export interface DomainCost {
    domain: string;
    domainSuffix: string;
    domainWeight: number;
    creditCost: number;
}

export interface PricingEngine {
    /**
     * Returns the required credit for a given (actionKey, domain), using
     * cached pricing rules.
     *
     * Throws `UnknownActionError` for unrecognised action keys
     * (Requirement 6.1, error code `unknown_action`).
     */
    resolve(args: { actionKey: string; domain: string }): Promise<number>;

    /**
     * Typed accessor for numeric (or boolean-as-number) rules. Reads through
     * the cache.
     */
    getNumber(ruleKey: RuleKey): Promise<number>;

    /**
     * Typed accessor for object/array rules. Caller supplies the expected
     * shape as type parameter.
     */
    getObject<T>(ruleKey: RuleKey): Promise<T>;

    /** Clears the module-level cache (called by admin PUT). */
    invalidateCache(): void;

    /**
     * Returns per-action credit cost for every active domain. Used by the
     * `GET /user_api/billing/domains` endpoint.
     */
    listDomainCosts(actionKey: string): Promise<DomainCost[]>;
}

// ─── Implementation ──────────────────────────────────────────────────────────

export class Pricing_Engine implements PricingEngine {
    constructor(private readonly db: D1Database) {}

    async resolve(args: { actionKey: string; domain: string }): Promise<number> {
        const { actionKey, domain } = args;

        switch (actionKey) {
            case 'create_address': {
                const weight = await this.resolveDomainWeight(domain);
                const cost = await this.getNumber('action_cost_create_address');
                return weight * cost;
            }
            case 'send_mail':
                // High-cost action: constant credits, NOT multiplied by domain weight
                return this.getNumber('action_cost_send_mail');
            case 'forward_mail':
                // High-cost action: constant credits, NOT multiplied by domain weight
                return this.getNumber('action_cost_forward_mail');
            default:
                throw new UnknownActionError(actionKey);
        }
    }

    async getNumber(ruleKey: RuleKey): Promise<number> {
        const value = await this.readRule(ruleKey);
        if (typeof value === 'number') return value;
        if (typeof value === 'boolean') return value ? 1 : 0;
        throw new Error(
            `Pricing rule ${ruleKey} is not numeric: ${JSON.stringify(value)}`,
        );
    }

    async getObject<T>(ruleKey: RuleKey): Promise<T> {
        return (await this.readRule(ruleKey)) as T;
    }

    invalidateCache(): void {
        moduleCache.clear();
    }

    async listDomainCosts(actionKey: string): Promise<DomainCost[]> {
        // Read all active allowed_domains rows ordered deterministically.
        const { results } = await this.db
            .prepare(
                `SELECT domain FROM allowed_domains WHERE is_active = 1 ORDER BY domain`,
            )
            .all<{ domain: string }>();

        // Pre-fetch both weights once so we don't re-hit the cache per row.
        const weightCom = await this.getNumber('domain_weight_com');
        const weightDefault = await this.getNumber('domain_weight_default');

        const out: DomainCost[] = [];
        for (const row of results ?? []) {
            const suffix = extractSuffix(row.domain);
            const isCom = suffix === '.com';
            const domainWeight = isCom ? weightCom : weightDefault;
            const creditCost = await this.resolve({ actionKey, domain: row.domain });
            out.push({
                domain: row.domain,
                domainSuffix: suffix,
                domainWeight,
                creditCost,
            });
        }
        return out;
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    /**
     * Returns the domain weight for a given domain based on its suffix.
     *   suffix === ".com" → domain_weight_com
     *   otherwise         → domain_weight_default
     */
    private async resolveDomainWeight(domain: string): Promise<number> {
        const suffix = extractSuffix(domain);
        const ruleKey: RuleKey =
            suffix === '.com' ? 'domain_weight_com' : 'domain_weight_default';
        return this.getNumber(ruleKey);
    }

    /**
     * Reads a single pricing rule from cache or D1. Uses the
     * `is_active = 1 AND MAX(version)` row per rule_key.
     *
     * Throws `PricingRuleNotFoundError` when no active row exists.
     */
    private async readRule(ruleKey: string): Promise<unknown> {
        const cached = cacheGet(ruleKey);
        if (cached !== undefined) return cached;

        const row = await this.db
            .prepare(
                `SELECT rule_value_json FROM pricing_rules
                 WHERE rule_key = ? AND is_active = 1
                 ORDER BY version DESC
                 LIMIT 1`,
            )
            .bind(ruleKey)
            .first<{ rule_value_json: string }>();

        if (!row) {
            throw new PricingRuleNotFoundError(ruleKey);
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(row.rule_value_json);
        } catch {
            throw new Error(
                `Invalid rule_value_json for ${ruleKey}: ${row.rule_value_json}`,
            );
        }

        cacheSet(ruleKey, parsed);
        return parsed;
    }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a Pricing_Engine instance bound to the given D1 database.
 * Inject a compatible D1Database adapter in tests (e.g. a better-sqlite3
 * shim) so tests can run without the Cloudflare runtime.
 */
export function createPricingEngine(db: D1Database): PricingEngine {
    return new Pricing_Engine(db);
}
