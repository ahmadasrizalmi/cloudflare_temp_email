// Feature: saas-topup-billing, Property 33: Grandfather policy
/**
 * Property-based tests for the grandfather policy helper.
 *
 * Validates: Requirements 14.1, 14.2, 14.3, 14.5
 *
 * Property 33: Grandfather policy
 *   For any address `a`, action `A`, and current time `t`, with
 *   `a.created_at < billing_launch_at`:
 *   - if `A ∈ {send_mail, forward_mail}`, a DEBIT is always written per
 *     Pricing_Engine (shouldChargeCredit returns true);
 *   - if `A ∉ {send_mail, forward_mail}` (routine actions) and
 *     `t < billing_launch_at + grandfather_period_days`, no DEBIT is written
 *     (shouldChargeCredit returns false);
 *   - if `t >= billing_launch_at + grandfather_period_days`, a DEBIT is written
 *     per Pricing_Engine (shouldChargeCredit returns true).
 *   For any address created after `billing_launch_at`, a DEBIT is written per
 *   Pricing_Engine regardless of action.
 */

import fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import {
    isGrandfathered,
    isHighCostAction,
    shouldChargeCredit,
    shouldChargeDebit,
    HIGH_COST_ACTIONS,
    createGrandfatherHelper,
    type GrandfatherPricingSource,
} from '../grandfather.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Arbitrary: a date expressed as a timestamp (ms since epoch). */
const dateMs = () => fc.integer({ min: 0, max: 2_000_000_000_000 });

/** Arbitrary: grandfather period in days [1..365]. */
const periodDays = () => fc.integer({ min: 1, max: 365 });

/** Arbitrary: action key from the full set used in the system. */
const actionKey = () =>
    fc.oneof(
        fc.constant('create_address'),
        fc.constant('send_mail'),
        fc.constant('forward_mail'),
        fc.constant('list_mails'),
        fc.constant('read_mail'),
        fc.string({ minLength: 1, maxLength: 30 }),
    );

// ─── isHighCostAction ─────────────────────────────────────────────────────────

describe('isHighCostAction', () => {
    it('returns true for send_mail and forward_mail', () => {
        expect(isHighCostAction('send_mail')).toBe(true);
        expect(isHighCostAction('forward_mail')).toBe(true);
    });

    it('returns false for all non-high-cost actions', () => {
        const routineActions = [
            'create_address',
            'list_mails',
            'read_mail',
            'delete_address',
            'update_address',
        ];
        for (const action of routineActions) {
            expect(isHighCostAction(action)).toBe(false);
        }
    });

    it('property: only send_mail and forward_mail are high-cost', () => {
        fc.assert(
            fc.property(actionKey(), (action) => {
                const result = isHighCostAction(action);
                if (HIGH_COST_ACTIONS.has(action)) {
                    expect(result).toBe(true);
                } else {
                    expect(result).toBe(false);
                }
            }),
            { numRuns: 100 },
        );
    });
});

// ─── isGrandfathered ──────────────────────────────────────────────────────────

describe('isGrandfathered', () => {
    it('returns false when address was created after billing launch', () => {
        fc.assert(
            fc.property(
                dateMs(),
                periodDays(),
                (launchMs, days) => {
                    const launch = new Date(launchMs);
                    // Address created 1ms after launch
                    const createdAfter = new Date(launchMs + 1);
                    const now = new Date(launchMs + 1000);
                    expect(isGrandfathered(createdAfter, launch, days, now)).toBe(false);
                },
            ),
            { numRuns: 100 },
        );
    });

    it('returns false when address was created exactly at billing launch', () => {
        fc.assert(
            fc.property(
                dateMs(),
                periodDays(),
                (launchMs, days) => {
                    const launch = new Date(launchMs);
                    const createdAt = new Date(launchMs); // exactly at launch
                    const now = new Date(launchMs + 1000);
                    expect(isGrandfathered(createdAt, launch, days, now)).toBe(false);
                },
            ),
            { numRuns: 100 },
        );
    });

    it('returns true when address pre-dates launch and now is within window', () => {
        fc.assert(
            fc.property(
                dateMs(),
                periodDays(),
                fc.integer({ min: 1, max: 1_000_000 }), // ms before launch
                (launchMs, days, msBefore) => {
                    const launch = new Date(launchMs);
                    const createdBefore = new Date(launchMs - msBefore);
                    // now is 1ms before window end
                    const windowEndMs = launchMs + days * MS_PER_DAY;
                    const now = new Date(windowEndMs - 1);
                    expect(isGrandfathered(createdBefore, launch, days, now)).toBe(true);
                },
            ),
            { numRuns: 100 },
        );
    });

    it('returns false when grandfather window has expired', () => {
        fc.assert(
            fc.property(
                dateMs(),
                periodDays(),
                fc.integer({ min: 1, max: 1_000_000 }), // ms before launch
                (launchMs, days, msBefore) => {
                    const launch = new Date(launchMs);
                    const createdBefore = new Date(launchMs - msBefore);
                    // now is exactly at window end (boundary: not within window)
                    const windowEndMs = launchMs + days * MS_PER_DAY;
                    const now = new Date(windowEndMs);
                    expect(isGrandfathered(createdBefore, launch, days, now)).toBe(false);
                },
            ),
            { numRuns: 100 },
        );
    });

    it('returns false when now is past the grandfather window', () => {
        fc.assert(
            fc.property(
                dateMs(),
                periodDays(),
                fc.integer({ min: 1, max: 1_000_000 }),
                fc.integer({ min: 1, max: 1_000_000 }), // ms after window end
                (launchMs, days, msBefore, msAfterWindow) => {
                    const launch = new Date(launchMs);
                    const createdBefore = new Date(launchMs - msBefore);
                    const windowEndMs = launchMs + days * MS_PER_DAY;
                    const now = new Date(windowEndMs + msAfterWindow);
                    expect(isGrandfathered(createdBefore, launch, days, now)).toBe(false);
                },
            ),
            { numRuns: 100 },
        );
    });

    it('accepts string dates as well as Date objects', () => {
        const launch = '2026-01-01T00:00:00.000Z';
        const createdBefore = '2025-12-01T00:00:00.000Z';
        const now = new Date('2026-01-15T00:00:00.000Z'); // within 30-day window
        expect(isGrandfathered(createdBefore, launch, 30, now)).toBe(true);
    });
});

// ─── shouldChargeCredit (Property 33) ────────────────────────────────────────

describe('shouldChargeCredit — Property 33: Grandfather policy', () => {
    /**
     * Core property: the decision matrix from Requirement 14.
     *
     * shouldChargeCredit returns false ONLY when:
     *   isGrandfathered(address, ...) === true AND !isHighCostAction(action)
     *
     * In all other cases it returns true.
     */
    it('matches the decision matrix for all input combinations', () => {
        fc.assert(
            fc.property(
                dateMs(),          // launchMs
                periodDays(),      // grandfatherPeriodDays
                dateMs(),          // addressCreatedAtMs (relative to launch)
                dateMs(),          // nowMs (relative to launch)
                actionKey(),       // action
                (launchMs, days, rawCreatedMs, rawNowMs, action) => {
                    const launch = new Date(launchMs);
                    // Use raw values as offsets so we get a mix of before/after
                    const createdAt = new Date(rawCreatedMs);
                    const now = new Date(rawNowMs);

                    const grandfathered = isGrandfathered(createdAt, launch, days, now);
                    const highCost = isHighCostAction(action);

                    const expected = !(grandfathered && !highCost);
                    const actual = shouldChargeCredit(createdAt, action, launch, days, now);

                    expect(actual).toBe(expected);
                },
            ),
            { numRuns: 100 },
        );
    });

    it('Req 14.2: high-cost actions are always charged, even for grandfathered addresses', () => {
        fc.assert(
            fc.property(
                dateMs(),
                periodDays(),
                fc.integer({ min: 1, max: 1_000_000 }), // ms before launch
                fc.oneof(fc.constant('send_mail'), fc.constant('forward_mail')),
                (launchMs, days, msBefore, action) => {
                    const launch = new Date(launchMs);
                    const createdBefore = new Date(launchMs - msBefore);
                    // now is within the grandfather window
                    const windowEndMs = launchMs + days * MS_PER_DAY;
                    const now = new Date(windowEndMs - 1);

                    // Confirm the address IS grandfathered
                    expect(isGrandfathered(createdBefore, launch, days, now)).toBe(true);

                    // High-cost action must still be charged
                    expect(shouldChargeCredit(createdBefore, action, launch, days, now)).toBe(true);
                },
            ),
            { numRuns: 100 },
        );
    });

    it('Req 14.1: routine actions on grandfathered addresses are NOT charged during window', () => {
        fc.assert(
            fc.property(
                dateMs(),
                periodDays(),
                fc.integer({ min: 1, max: 1_000_000 }),
                fc.oneof(
                    fc.constant('create_address'),
                    fc.constant('list_mails'),
                    fc.constant('read_mail'),
                ),
                (launchMs, days, msBefore, action) => {
                    const launch = new Date(launchMs);
                    const createdBefore = new Date(launchMs - msBefore);
                    const windowEndMs = launchMs + days * MS_PER_DAY;
                    const now = new Date(windowEndMs - 1);

                    expect(shouldChargeCredit(createdBefore, action, launch, days, now)).toBe(false);
                },
            ),
            { numRuns: 100 },
        );
    });

    it('Req 14.3: new addresses (created after launch) are always charged', () => {
        fc.assert(
            fc.property(
                dateMs(),
                periodDays(),
                fc.integer({ min: 1, max: 1_000_000 }), // ms after launch
                actionKey(),
                (launchMs, days, msAfter, action) => {
                    const launch = new Date(launchMs);
                    const createdAfter = new Date(launchMs + msAfter);
                    const now = new Date(launchMs + 1000);

                    expect(shouldChargeCredit(createdAfter, action, launch, days, now)).toBe(true);
                },
            ),
            { numRuns: 100 },
        );
    });

    it('Req 14.5: after grandfather window expires, all addresses are charged', () => {
        fc.assert(
            fc.property(
                dateMs(),
                periodDays(),
                fc.integer({ min: 1, max: 1_000_000 }),
                fc.integer({ min: 0, max: 1_000_000 }), // ms after window end
                actionKey(),
                (launchMs, days, msBefore, msAfterWindow, action) => {
                    const launch = new Date(launchMs);
                    const createdBefore = new Date(launchMs - msBefore);
                    const windowEndMs = launchMs + days * MS_PER_DAY;
                    const now = new Date(windowEndMs + msAfterWindow);

                    expect(shouldChargeCredit(createdBefore, action, launch, days, now)).toBe(true);
                },
            ),
            { numRuns: 100 },
        );
    });
});

// ─── shouldChargeDebit (object-param alias) ───────────────────────────────────

describe('shouldChargeDebit (object-param alias)', () => {
    it('produces identical results to shouldChargeCredit', () => {
        fc.assert(
            fc.property(
                dateMs(),
                periodDays(),
                dateMs(),
                dateMs(),
                actionKey(),
                (launchMs, days, rawCreatedMs, rawNowMs, action) => {
                    const launch = new Date(launchMs);
                    const createdAt = new Date(rawCreatedMs);
                    const now = new Date(rawNowMs);

                    const positional = shouldChargeCredit(createdAt, action, launch, days, now);
                    const objectParam = shouldChargeDebit({
                        action,
                        addressCreatedAt: createdAt,
                        billingLaunchAt: launch,
                        grandfatherPeriodDays: days,
                        now,
                    });

                    expect(objectParam).toBe(positional);
                },
            ),
            { numRuns: 100 },
        );
    });
});

// ─── createGrandfatherHelper factory ─────────────────────────────────────────

describe('createGrandfatherHelper factory', () => {
    function makeMockSource(
        grandfatherPeriodDays: number,
        billingLaunchAt: string,
    ): GrandfatherPricingSource {
        return {
            async getNumber(_key: 'grandfather_period_days') {
                return grandfatherPeriodDays;
            },
            async getBillingLaunchAt() {
                return billingLaunchAt;
            },
        };
    }

    it('creates a helper that delegates to the core functions', async () => {
        const launchMs = Date.now() - 10 * MS_PER_DAY; // 10 days ago
        const launch = new Date(launchMs).toISOString();
        const helper = await createGrandfatherHelper(makeMockSource(30, launch));

        const createdBefore = new Date(launchMs - MS_PER_DAY); // 1 day before launch
        const now = new Date(launchMs + 5 * MS_PER_DAY);       // 5 days after launch (within window)

        // Routine action on grandfathered address → no charge
        expect(helper.shouldChargeCredit(createdBefore, 'create_address', now)).toBe(false);

        // High-cost action on grandfathered address → charge
        expect(helper.shouldChargeCredit(createdBefore, 'send_mail', now)).toBe(true);
        expect(helper.shouldChargeCredit(createdBefore, 'forward_mail', now)).toBe(true);
    });

    it('factory helper matches standalone functions for arbitrary inputs', async () => {
        await fc.assert(
            fc.asyncProperty(
                dateMs(),
                periodDays(),
                dateMs(),
                dateMs(),
                actionKey(),
                async (launchMs, days, rawCreatedMs, rawNowMs, action) => {
                    const launch = new Date(launchMs);
                    const createdAt = new Date(rawCreatedMs);
                    const now = new Date(rawNowMs);

                    const helper = await createGrandfatherHelper(
                        makeMockSource(days, launch.toISOString()),
                    );

                    const fromHelper = helper.shouldChargeCredit(createdAt, action, now);
                    const standalone = shouldChargeCredit(createdAt, action, launch, days, now);

                    expect(fromHelper).toBe(standalone);
                },
            ),
            { numRuns: 100 },
        );
    });

    it('isHighCostAction on helper matches standalone', async () => {
        const helper = await createGrandfatherHelper(
            makeMockSource(30, new Date().toISOString()),
        );
        fc.assert(
            fc.property(actionKey(), (action) => {
                expect(helper.isHighCostAction(action)).toBe(isHighCostAction(action));
            }),
            { numRuns: 100 },
        );
    });

    it('shouldChargeDebit on helper matches shouldChargeCredit', async () => {
        await fc.assert(
            fc.asyncProperty(
                dateMs(),
                periodDays(),
                dateMs(),
                dateMs(),
                actionKey(),
                async (launchMs, days, rawCreatedMs, rawNowMs, action) => {
                    const launch = new Date(launchMs);
                    const createdAt = new Date(rawCreatedMs);
                    const now = new Date(rawNowMs);

                    const helper = await createGrandfatherHelper(
                        makeMockSource(days, launch.toISOString()),
                    );

                    const viaDebit = helper.shouldChargeDebit({
                        action,
                        addressCreatedAt: createdAt,
                        now,
                    });
                    const viaCredit = helper.shouldChargeCredit(createdAt, action, now);

                    expect(viaDebit).toBe(viaCredit);
                },
            ),
            { numRuns: 100 },
        );
    });
});
