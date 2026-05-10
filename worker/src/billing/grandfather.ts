/**
 * Grandfather policy helper for SaaS billing.
 *
 * Implements the backward-compatibility rules from Requirement 14:
 *   - Addresses created before `billing_launch_at` are "grandfathered" for a
 *     configurable period (`grandfather_period_days`).
 *   - During the grandfather window, routine actions (non-high-cost) are NOT
 *     charged.
 *   - High-cost actions (`send_mail`, `forward_mail`) are ALWAYS charged, even
 *     for grandfathered addresses (Requirement 14.2).
 *   - Once the grandfather window expires, all addresses are charged normally.
 *   - Addresses created after `billing_launch_at` are always charged.
 *
 * Feature: saas-topup-billing
 * Requirements: 14.1, 14.2, 14.3, 14.4, 14.5
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Action keys that are always charged, even for grandfathered addresses.
 * Per Requirement 14.2.
 */
export const HIGH_COST_ACTIONS: ReadonlySet<string> = new Set([
    'send_mail',
    'forward_mail',
]);

// ─── Core helpers ─────────────────────────────────────────────────────────────

/**
 * Returns `true` when the given address qualifies for the grandfather exemption:
 *   1. The address was created BEFORE `billingLaunchAt`, AND
 *   2. The current time (`now`) is still within the grandfather window
 *      (i.e. `now < billingLaunchAt + grandfatherPeriodDays`).
 *
 * Supports two call forms:
 *   - Object-param (preferred, matches tasks.md §11.4):
 *     `isGrandfathered({addressCreatedAt, now, billingLaunchAt, grandfatherPeriodDays})`
 *   - Positional (legacy, retained for existing callers/tests):
 *     `isGrandfathered(addressCreatedAt, billingLaunchAt, grandfatherPeriodDays, now?)`
 *
 * Requirements: 14.1, 14.4, 14.5
 */
export function isGrandfathered(args: IsGrandfatheredArgs): boolean;
export function isGrandfathered(
    addressCreatedAt: Date | string,
    billingLaunchAt: Date | string,
    grandfatherPeriodDays: number,
    now?: Date,
): boolean;
export function isGrandfathered(
    argsOrCreatedAt: IsGrandfatheredArgs | Date | string,
    billingLaunchAt?: Date | string,
    grandfatherPeriodDays?: number,
    now?: Date,
): boolean {
    // Normalise the two call forms into positional values.
    let createdAtVal: Date | string;
    let launchVal: Date | string;
    let days: number;
    let nowVal: Date;

    if (isIsGrandfatheredArgs(argsOrCreatedAt)) {
        createdAtVal = argsOrCreatedAt.addressCreatedAt;
        launchVal = argsOrCreatedAt.billingLaunchAt;
        days = argsOrCreatedAt.grandfatherPeriodDays;
        nowVal = argsOrCreatedAt.now ?? new Date();
    } else {
        createdAtVal = argsOrCreatedAt;
        launchVal = billingLaunchAt as Date | string;
        days = grandfatherPeriodDays as number;
        nowVal = now ?? new Date();
    }

    const createdMs = toMs(createdAtVal);
    const launchMs = toMs(launchVal);
    const windowEndMs = launchMs + days * MS_PER_DAY;
    const nowMs = nowVal.getTime();

    // Condition 1: address pre-dates billing launch
    if (createdMs >= launchMs) return false;

    // Condition 2: still within the grandfather window
    return nowMs < windowEndMs;
}

/** Type-guard distinguishing the object-param call form. */
function isIsGrandfatheredArgs(x: unknown): x is IsGrandfatheredArgs {
    return (
        typeof x === 'object' &&
        x !== null &&
        !(x instanceof Date) &&
        'addressCreatedAt' in x &&
        'billingLaunchAt' in x &&
        'grandfatherPeriodDays' in x
    );
}

/**
 * Returns `true` for action keys that are considered "high-cost" and are
 * therefore NEVER exempt from billing, even for grandfathered addresses.
 *
 * Currently: `send_mail` and `forward_mail`.
 *
 * Requirement: 14.2
 */
export function isHighCostAction(actionKey: string): boolean {
    return HIGH_COST_ACTIONS.has(actionKey);
}

/**
 * Determines whether a credit debit should be charged for a given action on a
 * given address.
 *
 * Returns `false` (skip charge) only when ALL of the following hold:
 *   - The address is grandfathered (`isGrandfathered` returns `true`), AND
 *   - The action is NOT high-cost (`isHighCostAction` returns `false`).
 *
 * In all other cases returns `true` (charge the user).
 *
 * Requirements: 14.1, 14.2, 14.3, 14.5
 */
export function shouldChargeCredit(
    addressCreatedAt: Date | string,
    actionKey: string,
    billingLaunchAt: Date | string,
    grandfatherPeriodDays: number,
    now: Date = new Date(),
): boolean {
    // High-cost actions are always charged (Req 14.2)
    if (isHighCostAction(actionKey)) return true;

    // If the address is grandfathered, skip the charge for routine actions
    if (isGrandfathered(addressCreatedAt, billingLaunchAt, grandfatherPeriodDays, now)) {
        return false;
    }

    // All other cases: charge
    return true;
}

// ─── Object-param overloads (used by integrated handlers) ────────────────────

export interface IsGrandfatheredArgs {
    addressCreatedAt: Date | string;
    now?: Date;
    billingLaunchAt: Date | string;
    grandfatherPeriodDays: number;
}

export interface ShouldChargeDebitArgs {
    action: string;
    addressCreatedAt: Date | string;
    now?: Date;
    billingLaunchAt: Date | string;
    grandfatherPeriodDays: number;
}

/**
 * Object-param variant of `isGrandfathered` — preferred by integrated handlers
 * that receive a structured context object.
 */
export function isGrandfatheredObj(args: IsGrandfatheredArgs): boolean {
    return isGrandfathered(
        args.addressCreatedAt,
        args.billingLaunchAt,
        args.grandfatherPeriodDays,
        args.now ?? new Date(),
    );
}

/**
 * Object-param variant of `shouldChargeCredit` — preferred by integrated
 * handlers. Alias: `shouldChargeDebit` (matches tasks.md naming).
 */
export function shouldChargeDebit(args: ShouldChargeDebitArgs): boolean {
    return shouldChargeCredit(
        args.addressCreatedAt,
        args.action,
        args.billingLaunchAt,
        args.grandfatherPeriodDays,
        args.now ?? new Date(),
    );
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export interface GrandfatherHelperConfig {
    billingLaunchAt: Date | string;
    grandfatherPeriodDays: number;
}

export interface GrandfatherHelper {
    isGrandfathered(addressCreatedAt: Date | string, now?: Date): boolean;
    isHighCostAction(actionKey: string): boolean;
    shouldChargeCredit(addressCreatedAt: Date | string, actionKey: string, now?: Date): boolean;
    /** Alias for `shouldChargeCredit` — matches tasks.md naming. */
    shouldChargeDebit(args: { action: string; addressCreatedAt: Date | string; now?: Date }): boolean;
}

/**
 * Minimal interface that the factory reads from the pricing engine / env.
 * Only the two grandfather-related rule keys are required.
 */
export interface GrandfatherPricingSource {
    getNumber(ruleKey: 'grandfather_period_days'): Promise<number>;
    /** Returns the `BILLING_LAUNCH_AT` env var or a stored rule value. */
    getBillingLaunchAt(): Promise<string>;
}

/**
 * Creates a `GrandfatherHelper` by reading `grandfather_period_days` and
 * `billing_launch_at` from the provided pricing engine / env source.
 *
 * Usage:
 * ```ts
 * const helper = await createGrandfatherHelper(pricingEngine);
 * if (!helper.shouldChargeCredit(address.created_at, 'create_address')) {
 *   // skip debit — grandfathered address in routine action window
 * }
 * ```
 *
 * Requirements: 14.4
 */
export async function createGrandfatherHelper(
    source: GrandfatherPricingSource,
): Promise<GrandfatherHelper> {
    const [grandfatherPeriodDays, billingLaunchAt] = await Promise.all([
        source.getNumber('grandfather_period_days'),
        source.getBillingLaunchAt(),
    ]);

    return {
        isGrandfathered(addressCreatedAt: Date | string, now: Date = new Date()): boolean {
            return isGrandfathered(addressCreatedAt, billingLaunchAt, grandfatherPeriodDays, now);
        },

        isHighCostAction(actionKey: string): boolean {
            return isHighCostAction(actionKey);
        },

        shouldChargeCredit(
            addressCreatedAt: Date | string,
            actionKey: string,
            now: Date = new Date(),
        ): boolean {
            return shouldChargeCredit(addressCreatedAt, actionKey, billingLaunchAt, grandfatherPeriodDays, now);
        },

        shouldChargeDebit(args: { action: string; addressCreatedAt: Date | string; now?: Date }): boolean {
            return shouldChargeCredit(
                args.addressCreatedAt,
                args.action,
                billingLaunchAt,
                grandfatherPeriodDays,
                args.now ?? new Date(),
            );
        },
    };
}

// ─── Internal utilities ───────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toMs(value: Date | string): number {
    if (value instanceof Date) return value.getTime();
    return new Date(value).getTime();
}
