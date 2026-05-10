/**
 * Paid-action billing integration helpers.
 *
 * Feature: saas-topup-billing
 * Requirements: 2.4, 2.5, 2.6, 2.7, 6.1, 6.2, 6.3, 6.6, 6.7, 13.3, 14.1, 14.3
 *
 * These helpers bridge the existing paid-action route handlers (e.g.
 * `/api/new_address`, `/api/send_mail`) with the billing stack
 * (`Abuse_Guard`, `Pricing_Engine`, `Wallet_Service`, grandfather policy).
 *
 * They are designed to be additive: when `BILLING_ENABLED=false` (legacy
 * installations), `preCheckCreateAddress` returns `{ skipped: true }` and the
 * caller proceeds exactly as before. When billing is enabled but the caller
 * is anonymous (no `x-user-token`), billing is also skipped — anonymous users
 * have no wallet and cannot be charged.
 */

import type { Context } from 'hono';

import i18n from '../i18n';
import { getBooleanValue } from '../utils';
import {
    abuseGuard as defaultAbuseGuard,
    FingerprintRequiredError,
    RateLimitedError,
    RateLimitUnavailableError,
    type AbuseGuard,
} from './abuse_guard';
import {
    createPricingEngine,
    PricingRuleNotFoundError,
    UnknownActionError,
    type PricingEngine,
} from './pricing_engine';
import {
    createWalletService,
    InsufficientCreditError,
    NegativeBalanceError,
    type WalletService,
} from './wallet_service';
import { shouldChargeDebit } from './grandfather';

// ─── Error types ──────────────────────────────────────────────────────────────

/** Thrown when a request targets a domain not in `allowed_domains`. HTTP 400. */
export class DomainNotAllowedError extends Error {
    readonly code = 'domain_not_allowed' as const;
    readonly httpStatus = 400 as const;
    constructor(public readonly domain?: string) {
        super(
            domain
                ? `Domain ${domain} is not allowed for paid actions`
                : 'Domain is not allowed for paid actions',
        );
        this.name = 'DomainNotAllowedError';
    }
}

// ─── Module-level helpers ─────────────────────────────────────────────────────

/** Returns true when billing enforcement is active for the current environment. */
export function isBillingEnabled(env: Bindings): boolean {
    return getBooleanValue(env.BILLING_ENABLED);
}

/**
 * Check that `domain` is present in `allowed_domains` with `is_active=1`.
 * Comparison is case-insensitive (domain is normalized to lowercase).
 */
async function isDomainAllowed(db: D1Database, domain: string): Promise<boolean> {
    const normalized = domain.trim().toLowerCase();
    if (!normalized) return false;
    const row = await db
        .prepare(
            `SELECT 1 AS ok FROM allowed_domains
             WHERE domain = ? AND is_active = 1
             LIMIT 1`,
        )
        .bind(normalized)
        .first<{ ok: number }>();
    return !!row;
}

// ─── Pre-check result types ───────────────────────────────────────────────────

export interface CreateAddressBillingContext {
    userId: number;
    /** Normalized domain (lowercase, trimmed) that the user intends to create. */
    domain: string;
    /** Credits to debit; derived from Pricing_Engine.resolve. */
    requiredCredit: number;
    /** Bound Wallet_Service instance (reused so tests can inject). */
    walletService: WalletService;
    /** Bound Pricing_Engine instance. */
    pricingEngine: PricingEngine;
    /**
     * Grandfather policy outcome. For brand-new addresses this will always be
     * `true` (the address is being created "now", so it post-dates launch and
     * is never grandfathered). Kept for consistency with §14 requirements.
     */
    shouldCharge: boolean;
}

export type CreateAddressPreCheck =
    | { skipped: true; reason: 'billing_disabled' | 'anonymous' }
    | { skipped: false; context: CreateAddressBillingContext };

export interface SendMailBillingContext {
    userId: number;
    senderAddress: string;
    domain: string;
    requiredCredit: number;
    walletService: WalletService;
    shouldCharge: boolean;
}

export type SendMailPreCheck =
    | { skipped: true; reason: 'billing_disabled' | 'anonymous' }
    | { skipped: false; context: SendMailBillingContext };

// ─── Dependency wiring (overridable per request for testing) ─────────────────

export interface PaidActionDeps {
    pricingEngine?: (c: Context<HonoCustomType>) => PricingEngine;
    walletService?: (c: Context<HonoCustomType>) => WalletService;
    abuseGuard?: AbuseGuard;
    /** Override current time; useful in tests. */
    now?: () => Date;
}

function resolvePricingEngine(
    c: Context<HonoCustomType>,
    deps: PaidActionDeps,
): PricingEngine {
    return deps.pricingEngine
        ? deps.pricingEngine(c)
        : createPricingEngine(c.env.DB);
}

function resolveWalletService(
    c: Context<HonoCustomType>,
    deps: PaidActionDeps,
): WalletService {
    return deps.walletService
        ? deps.walletService(c)
        : createWalletService(c.env.DB);
}

function resolveAbuseGuard(deps: PaidActionDeps): AbuseGuard {
    return deps.abuseGuard ?? defaultAbuseGuard;
}

// ─── preCheckCreateAddress ───────────────────────────────────────────────────

/**
 * Pre-check gating for the `create_address` paid action. Performs, in order:
 *
 *   1. Billing-enabled + authenticated-user gate; early-exit with
 *      `{ skipped: true }` for anonymous or billing-disabled flows so the
 *      existing handler runs unchanged.
 *   2. `Abuse_Guard.requireFingerprint` — throws `FingerprintRequiredError`
 *      (HTTP 400) when the `x-fingerprint` header is missing/empty.
 *   3. Validates `domain` is a non-empty string present in
 *      `allowed_domains WHERE is_active = 1` — throws `DomainNotAllowedError`
 *      (HTTP 400) otherwise.
 *   4. Resolves `required_credit` via `Pricing_Engine.resolve`. Propagates
 *      `UnknownActionError` / `PricingRuleNotFoundError` upward.
 *   5. Consults the grandfather helper. For a brand-new address
 *      (`addressCreatedAt = now`) this always returns `true`; the call is
 *      retained for consistency with §14 and to keep the integration
 *      symmetric with send_mail/forward_mail.
 *
 * Returns the billing context ready for the caller to invoke
 * `executeDebit(...)` after the address row has been inserted.
 *
 * Requirements: 2.4, 2.5, 2.6, 2.7, 6.1, 13.3, 14.1, 14.3, 10.5
 */
export async function preCheckCreateAddress(
    c: Context<HonoCustomType>,
    domain: string | undefined | null,
    deps: PaidActionDeps = {},
): Promise<CreateAddressPreCheck> {
    // 1. Billing / auth gate — keep legacy behaviour for anonymous or
    //    billing-disabled environments.
    if (!isBillingEnabled(c.env)) {
        return { skipped: true, reason: 'billing_disabled' };
    }
    const userPayload = c.get('userPayload');
    if (!userPayload) {
        return { skipped: true, reason: 'anonymous' };
    }
    const userId = userPayload.user_id;

    // 2. Fingerprint header required for all billing-protected endpoints.
    const guard = resolveAbuseGuard(deps);
    await guard.requireFingerprint(c);

    // 3. Normalize and validate the target domain. We are strict here: a
    //    domain MUST be explicitly provided when billing is enabled so the
    //    debited cost and the resolved allowlist agree.
    const normalizedDomain =
        typeof domain === 'string' ? domain.trim().toLowerCase() : '';
    if (!normalizedDomain) {
        throw new DomainNotAllowedError();
    }
    const allowed = await isDomainAllowed(c.env.DB, normalizedDomain);
    if (!allowed) {
        throw new DomainNotAllowedError(normalizedDomain);
    }

    // 4. Resolve the credit cost via the pricing engine.
    const pricingEngine = resolvePricingEngine(c, deps);
    const walletService = resolveWalletService(c, deps);
    const requiredCredit = await pricingEngine.resolve({
        actionKey: 'create_address',
        domain: normalizedDomain,
    });

    // 5. Grandfather policy — always compute, even though a new address
    //    (addressCreatedAt === now) can never be grandfathered.
    const now = (deps.now ?? (() => new Date()))();
    const billingLaunchAt = c.env.BILLING_LAUNCH_AT || '1970-01-01';
    let grandfatherPeriodDays: number;
    try {
        grandfatherPeriodDays = await pricingEngine.getNumber('grandfather_period_days');
    } catch {
        // Defensive default matching design.md seed (30 days) if the rule is
        // not yet present in pricing_rules.
        grandfatherPeriodDays = 30;
    }
    const shouldCharge = shouldChargeDebit({
        action: 'create_address',
        addressCreatedAt: now,
        now,
        billingLaunchAt,
        grandfatherPeriodDays,
    });

    return {
        skipped: false,
        context: {
            userId,
            domain: normalizedDomain,
            requiredCredit,
            walletService,
            pricingEngine,
            shouldCharge,
        },
    };
}

export async function preCheckSendMail(
    c: Context<HonoCustomType>,
    senderAddress: string | undefined | null,
    deps: PaidActionDeps = {},
): Promise<SendMailPreCheck> {
    if (!isBillingEnabled(c.env)) {
        return { skipped: true, reason: 'billing_disabled' };
    }
    const userPayload = c.get('userPayload');
    if (!userPayload) {
        return { skipped: true, reason: 'anonymous' };
    }
    const userId = userPayload.user_id;
    const normalizedAddress = typeof senderAddress === 'string' ? senderAddress.trim().toLowerCase() : '';
    if (!normalizedAddress || !normalizedAddress.includes('@')) {
        throw new DomainNotAllowedError();
    }

    const guard = resolveAbuseGuard(deps);
    await guard.requireFingerprint(c);

    const domain = normalizedAddress.split('@')[1]?.trim().toLowerCase() || '';
    if (!domain) {
        throw new DomainNotAllowedError();
    }

    const pricingEngine = resolvePricingEngine(c, deps);
    const walletService = resolveWalletService(c, deps);
    const requiredCredit = await pricingEngine.resolve({
        actionKey: 'send_mail',
        domain,
    });

    const now = (deps.now ?? (() => new Date()))();
    const billingLaunchAt = c.env.BILLING_LAUNCH_AT || '1970-01-01';
    let grandfatherPeriodDays = 30;
    try {
        grandfatherPeriodDays = await pricingEngine.getNumber('grandfather_period_days');
    } catch {
        // keep default
    }

    const addressCreatedAtRow = await c.env.DB
        .prepare(`SELECT created_at FROM address WHERE name = ? LIMIT 1`)
        .bind(normalizedAddress)
        .first<{ created_at: string }>();
    const addressCreatedAt = addressCreatedAtRow?.created_at
        ? new Date(addressCreatedAtRow.created_at)
        : now;

    const shouldCharge = shouldChargeDebit({
        action: 'send_mail',
        addressCreatedAt,
        now,
        billingLaunchAt,
        grandfatherPeriodDays,
    });

    return {
        skipped: false,
        context: {
            userId,
            senderAddress: normalizedAddress,
            domain,
            requiredCredit,
            walletService,
            shouldCharge,
        },
    };
}

// ─── Debit + compensating cleanup ────────────────────────────────────────────

export interface DebitOutcome {
    /** Ledger id of the DEBIT row. 0 when billing was skipped. */
    ledgerId: number;
    newBalance: number;
}

/**
 * Execute the `create_address` debit after the address row has been inserted.
 *
 * Design note on atomicity: D1 does not expose user-level transactions across
 * `.run()` calls, so "same logical transaction" cannot be implemented as a
 * single SQL transaction. Instead we:
 *   - Insert the address first (caller's responsibility).
 *   - Call `Wallet_Service.debit`, which IS atomic (single D1 batch combining
 *     the balance guard + ledger insert).
 *   - On debit failure, call `rollbackAddress(...)` to best-effort delete the
 *     just-inserted address row so no unpaid resource remains.
 *
 * This matches the §"Paid action" sequence diagram's failure compensation
 * semantics while satisfying task 11.1's "after the address row is inserted".
 *
 * Requirements: 6.2, 6.3, 6.6, 6.7
 */
export async function executeCreateAddressDebit(
    context: CreateAddressBillingContext,
    addressId: number,
): Promise<DebitOutcome> {
    const result = await context.walletService.debit({
        userId: context.userId,
        credits: context.requiredCredit,
        actionKey: 'create_address',
        domain: context.domain,
        resourceId: addressId,
    });
    return result;
}

export async function executeSendMailDebit(
    context: SendMailBillingContext,
    resourceId: string | number | undefined,
): Promise<DebitOutcome> {
    const result = await context.walletService.debit({
        userId: context.userId,
        credits: context.requiredCredit,
        actionKey: 'send_mail',
        domain: context.domain,
        resourceId,
    });
    return result;
}

/**
 * Best-effort compensating delete of the just-inserted address row.
 * Errors are logged but never re-thrown — the caller's primary error
 * response must not be masked by cleanup failures.
 */
export async function rollbackCreatedAddress(
    db: D1Database,
    addressId: number,
): Promise<void> {
    try {
        // Remove bindings first to keep foreign-key invariants (users_address
        // references address.id). No rows are expected since the address was
        // only just inserted, but we run this defensively.
        await db
            .prepare(`DELETE FROM users_address WHERE address_id = ?`)
            .bind(addressId)
            .run();
        await db
            .prepare(`DELETE FROM address WHERE id = ?`)
            .bind(addressId)
            .run();
    } catch (e) {
        console.error(
            '[paid_action] rollbackCreatedAddress failed for address_id=',
            addressId,
            e,
        );
    }
}

// ─── HTTP error rendering ─────────────────────────────────────────────────────

/**
 * Translate a billing-related error into a plain-text HTTP response using the
 * i18n catalog bound to the request. Returns `null` for errors the billing
 * layer does not recognise so the caller can re-throw and let the global
 * handler report them.
 *
 * HTTP status mapping (design.md §"Error taxonomy and HTTP mapping"):
 *   - FingerprintRequiredError      → 400 FingerprintRequiredMsg
 *   - DomainNotAllowedError         → 400 DomainNotAllowedMsg
 *   - RateLimitedError              → 429 RateLimitedMsg
 *   - RateLimitUnavailableError     → 503 RateLimitedMsg
 *   - InsufficientCreditError       → 402 InsufficientCreditMsg
 *   - NegativeBalanceError          → 400 NegativeBalanceNotAllowedMsg
 *   - UnknownActionError            → 400 UnknownActionMsg
 *   - PricingRuleNotFoundError      → 400 UnknownActionMsg
 */
export function renderBillingError(
    c: Context<HonoCustomType>,
    err: unknown,
): Response | null {
    const msgs = i18n.getMessagesbyContext(c);

    if (err instanceof FingerprintRequiredError) {
        return c.text(msgs.FingerprintRequiredMsg, 400);
    }
    if (err instanceof DomainNotAllowedError) {
        return c.text(msgs.DomainNotAllowedMsg, 400);
    }
    if (err instanceof RateLimitedError) {
        return c.text(msgs.RateLimitedMsg, 429);
    }
    if (err instanceof RateLimitUnavailableError) {
        return c.text(msgs.RateLimitedMsg, 503);
    }
    if (err instanceof InsufficientCreditError) {
        return c.text(msgs.InsufficientCreditMsg, 402);
    }
    if (err instanceof NegativeBalanceError) {
        return c.text(msgs.NegativeBalanceNotAllowedMsg, 400);
    }
    if (err instanceof UnknownActionError) {
        return c.text(msgs.UnknownActionMsg, 400);
    }
    if (err instanceof PricingRuleNotFoundError) {
        return c.text(msgs.UnknownActionMsg, 400);
    }
    return null;
}
