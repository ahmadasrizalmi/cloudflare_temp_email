// Feature: saas-topup-billing, Property 7: Pricing resolution correctness
/**
 * Property-based test for Pricing_Engine.resolve().
 *
 * Property 7: Pricing resolution correctness
 *   For every tuple (action_key, domain, domain_weight_com,
 *   domain_weight_default, action_cost_create_address,
 *   action_cost_send_mail, action_cost_forward_mail), the engine resolves the
 *   credit cost to exactly the value produced by the pure-function oracle from
 *   design.md §"Pricing_Engine":
 *
 *     suffix = extractSuffix(domain)
 *     isCom  = suffix === '.com'
 *     weight = isCom ? domain_weight_com : domain_weight_default
 *     switch (action):
 *       create_address → weight * action_cost_create_address
 *       send_mail      → action_cost_send_mail       (constant, NOT weighted)
 *       forward_mail   → action_cost_forward_mail    (constant, NOT weighted)
 *
 * Validates: Requirements 2.2, 2.4, 6.1, 6.5, 13.2, 19.3
 */

import fc from 'fast-check';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPricingEngine, extractSuffix } from '../pricing_engine.js';

// ─── Minimal fake D1 ─────────────────────────────────────────────────────────

/**
 * A single row in our fake `pricing_rules` table. Only the columns the
 * Pricing_Engine reads are materialised.
 */
interface FakePricingRuleRow {
    rule_key: string;
    rule_value_json: string;
    version: number;
    is_active: number; // 0 | 1
}

/**
 * Minimal in-memory D1 shim backed by a JS array of rows. Supports only the
 * subset of the D1Database surface that Pricing_Engine uses:
 *
 *   prepare(sql).bind(...).first<T>()
 *   prepare(sql).all<T>()
 *
 * The SQL isn't parsed — we pattern-match on the known queries issued by
 * `Pricing_Engine.readRule` and `Pricing_Engine.listDomainCosts`. That's
 * sufficient for Property 7, which only exercises `resolve()`.
 */
class FakeD1 {
    readonly pricingRules: FakePricingRuleRow[] = [];

    /** Reset all tables between property runs. */
    reset(): void {
        this.pricingRules.length = 0;
    }

    /** Seed or overwrite the active row for a given rule_key. */
    upsertActiveRule(ruleKey: string, value: unknown, version = 1): void {
        // Mark any prior active row inactive (not strictly necessary here since
        // we reset between runs, but it mirrors how the admin PUT works).
        for (const row of this.pricingRules) {
            if (row.rule_key === ruleKey) row.is_active = 0;
        }
        this.pricingRules.push({
            rule_key: ruleKey,
            rule_value_json: JSON.stringify(value),
            version,
            is_active: 1,
        });
    }

    prepare(sql: string): FakeD1PreparedStatement {
        return new FakeD1PreparedStatement(this, sql, []);
    }
}

class FakeD1PreparedStatement {
    constructor(
        private readonly db: FakeD1,
        private readonly sql: string,
        private readonly params: unknown[],
    ) {}

    bind(...params: unknown[]): FakeD1PreparedStatement {
        return new FakeD1PreparedStatement(this.db, this.sql, params);
    }

    // Minimal router: match on substrings of the known queries.
    async first<T = unknown>(): Promise<T | null> {
        if (this.isReadActivePricingRule()) {
            const [ruleKey] = this.params as [string];
            // SELECT rule_value_json FROM pricing_rules
            //   WHERE rule_key = ? AND is_active = 1
            //   ORDER BY version DESC LIMIT 1
            const match = this.db.pricingRules
                .filter((r) => r.rule_key === ruleKey && r.is_active === 1)
                .sort((a, b) => b.version - a.version)[0];
            if (!match) return null;
            return { rule_value_json: match.rule_value_json } as unknown as T;
        }
        throw new Error(`FakeD1.first(): unsupported SQL: ${this.sql}`);
    }

    async all<T = unknown>(): Promise<{ results: T[] }> {
        throw new Error(`FakeD1.all(): unsupported SQL: ${this.sql}`);
    }

    private isReadActivePricingRule(): boolean {
        const s = this.sql.replace(/\s+/g, ' ');
        return (
            s.includes('FROM pricing_rules') &&
            s.includes('rule_key = ?') &&
            s.includes('is_active = 1') &&
            s.includes('ORDER BY version DESC')
        );
    }
}

// ─── Pure-function oracle (mirrors design.md) ────────────────────────────────

interface OracleInputs {
    actionKey: 'create_address' | 'send_mail' | 'forward_mail';
    domain: string;
    domainWeightCom: number;
    domainWeightDefault: number;
    actionCostCreateAddress: number;
    actionCostSendMail: number;
    actionCostForwardMail: number;
}

function oracleResolve(i: OracleInputs): number {
    const suffix = extractSuffix(i.domain);
    const weight = suffix === '.com' ? i.domainWeightCom : i.domainWeightDefault;
    switch (i.actionKey) {
        case 'create_address':
            return weight * i.actionCostCreateAddress;
        case 'send_mail':
            return i.actionCostSendMail;
        case 'forward_mail':
            return i.actionCostForwardMail;
    }
}

// ─── fast-check generators ───────────────────────────────────────────────────

/** Action keys covered by Property 7. */
const actionKey = () =>
    fc.constantFrom('create_address', 'send_mail', 'forward_mail') as fc.Arbitrary<
        OracleInputs['actionKey']
    >;

/** Domain suffixes explicitly called out by the task. */
const domainSuffix = () =>
    fc.constantFrom('.com', '.web.id', '.my.id', '.id', '.co.id');

/**
 * Arbitrary: a host label (without leading dot). Short identifiers are enough
 * for the engine's suffix extraction — it only cares about what comes after
 * the first dot.
 */
const hostLabel = () =>
    fc
        .stringMatching(/^[a-z][a-z0-9]{0,10}$/)
        .filter((s) => s.length > 0);

/** Arbitrary: a full domain like `sarapanbakery.com` or `jagoseo.web.id`. */
const domain = () =>
    fc.tuple(hostLabel(), domainSuffix()).map(([label, suffix]) => `${label}${suffix}`);

// ─── Test suite ──────────────────────────────────────────────────────────────

describe('Pricing_Engine.resolve — Property 7: Pricing resolution correctness', () => {
    let fake: FakeD1;
    let nowSpy: ReturnType<typeof vi.spyOn> | null = null;

    beforeEach(() => {
        fake = new FakeD1();
    });
    afterEach(() => {
        if (nowSpy) {
            nowSpy.mockRestore();
            nowSpy = null;
        }
    });

    it('resolves every (action, domain) to the pure-function oracle result', async () => {
        await fc.assert(
            fc.asyncProperty(
                actionKey(),
                domain(),
                fc.integer({ min: 1, max: 5 }), // domain_weight_com ∈ [1..5]
                fc.integer({ min: 1, max: 3 }), // domain_weight_default ∈ [1..3]
                fc.integer({ min: 1, max: 20 }), // action_cost_create_address
                fc.integer({ min: 1, max: 50 }), // action_cost_send_mail
                fc.integer({ min: 1, max: 50 }), // action_cost_forward_mail
                async (
                    action,
                    dom,
                    weightCom,
                    weightDefault,
                    costCreateAddress,
                    costSendMail,
                    costForwardMail,
                ) => {
                    // Reset per-run state: the fake DB and the engine's
                    // module-level cache. Without this, cached rules from a
                    // prior run would leak across iterations.
                    fake.reset();
                    const engine = createPricingEngine(
                        fake as unknown as D1Database,
                    );
                    engine.invalidateCache();

                    fake.upsertActiveRule('domain_weight_com', weightCom);
                    fake.upsertActiveRule('domain_weight_default', weightDefault);
                    fake.upsertActiveRule(
                        'action_cost_create_address',
                        costCreateAddress,
                    );
                    fake.upsertActiveRule('action_cost_send_mail', costSendMail);
                    fake.upsertActiveRule('action_cost_forward_mail', costForwardMail);

                    const expected = oracleResolve({
                        actionKey: action,
                        domain: dom,
                        domainWeightCom: weightCom,
                        domainWeightDefault: weightDefault,
                        actionCostCreateAddress: costCreateAddress,
                        actionCostSendMail: costSendMail,
                        actionCostForwardMail: costForwardMail,
                    });

                    const actual = await engine.resolve({
                        actionKey: action,
                        domain: dom,
                    });

                    expect(actual).toBe(expected);
                },
            ),
            { numRuns: 100 },
        );
    });

    it('Property 8: cache determinism within TTL and refresh after expiry', async () => {
        await fc.assert(
            fc.asyncProperty(
                actionKey(),
                domain(),
                fc.integer({ min: 1, max: 5 }),
                fc.integer({ min: 1, max: 3 }),
                fc.integer({ min: 1, max: 20 }),
                fc.integer({ min: 1, max: 50 }),
                fc.integer({ min: 1, max: 50 }),
                fc.integer({ min: 1, max: 5 }),
                fc.integer({ min: 1, max: 12 }),
                async (
                    action,
                    dom,
                    weightCom,
                    weightDefault,
                    costCreateAddress,
                    costSendMail,
                    costForwardMail,
                    delta,
                    repeatCount,
                ) => {
                    fake.reset();
                    const engine = createPricingEngine(fake as unknown as D1Database);
                    engine.invalidateCache();

                    fake.upsertActiveRule('domain_weight_com', weightCom);
                    fake.upsertActiveRule('domain_weight_default', weightDefault);
                    fake.upsertActiveRule('action_cost_create_address', costCreateAddress);
                    fake.upsertActiveRule('action_cost_send_mail', costSendMail);
                    fake.upsertActiveRule('action_cost_forward_mail', costForwardMail);

                    const oldInput: OracleInputs = {
                        actionKey: action,
                        domain: dom,
                        domainWeightCom: weightCom,
                        domainWeightDefault: weightDefault,
                        actionCostCreateAddress: costCreateAddress,
                        actionCostSendMail: costSendMail,
                        actionCostForwardMail: costForwardMail,
                    };
                    const expectedOld = oracleResolve(oldInput);

                    let fakeNow = 1_700_000_000_000;
                    nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);

                    for (let i = 0; i < repeatCount; i++) {
                        const v = await engine.resolve({ actionKey: action, domain: dom });
                        expect(v).toBe(expectedOld);
                    }

                    fake.upsertActiveRule('domain_weight_com', weightCom + delta, 2);
                    fake.upsertActiveRule('domain_weight_default', weightDefault + delta, 2);
                    fake.upsertActiveRule('action_cost_create_address', costCreateAddress + delta, 2);
                    fake.upsertActiveRule('action_cost_send_mail', costSendMail + delta, 2);
                    fake.upsertActiveRule('action_cost_forward_mail', costForwardMail + delta, 2);

                    const stillCached = await engine.resolve({ actionKey: action, domain: dom });
                    expect(stillCached).toBe(expectedOld);

                    fakeNow += 61_000;
                    const expectedNew = oracleResolve({
                        actionKey: action,
                        domain: dom,
                        domainWeightCom: weightCom + delta,
                        domainWeightDefault: weightDefault + delta,
                        actionCostCreateAddress: costCreateAddress + delta,
                        actionCostSendMail: costSendMail + delta,
                        actionCostForwardMail: costForwardMail + delta,
                    });
                    const afterExpiry = await engine.resolve({ actionKey: action, domain: dom });
                    expect(afterExpiry).toBe(expectedNew);

                    nowSpy?.mockRestore();
                    nowSpy = null;
                },
            ),
            { numRuns: 100 },
        );
    });
});
