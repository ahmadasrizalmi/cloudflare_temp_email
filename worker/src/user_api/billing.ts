/**
 * User-facing Billing_API — wallet, ledger, top-up, domain preview.
 *
 * Feature: saas-topup-billing
 * Requirements: 1.5, 1.6, 2.1, 2.3, 2.5, 2.6, 2.7, 3.1, 3.2, 3.5, 4.2, 4.3, 4.4,
 *               4.5, 4.6, 4.7, 4.8, 4.9, 8.1, 8.2, 10.1, 10.2, 10.5, 11.5, 17.2
 *
 * Route registration is delegated to `worker/src/user_api/index.ts` (task 7.2).
 * This module exposes a factory `createBillingApi(deps?)` so routes inherit the
 * existing `/user_api/*` JWT middleware without any extra auth logic here.
 *
 * All routes:
 *   - Honour the `x-lang` header via `i18n.getMessagesbyContext(c)` (falls back
 *     to `DEFAULT_LANG` then `en`).
 *   - Map errors to the i18n keys registered in task 1.3.
 *   - Never return raw DompetX secrets; only `checkout_url` + `invoice_id`.
 */

import { Context, Hono } from 'hono';

import i18n from '../i18n';
import {
    abuseGuard as defaultAbuseGuard,
    FingerprintRequiredError,
    RateLimitedError,
    RateLimitUnavailableError,
    type AbuseGuard,
} from '../billing/abuse_guard';
import {
    createChannelCache,
    type ChannelCache,
    type DompetxChannel as CacheDompetxChannel,
    type DompetxChannelClient,
} from '../billing/channel_cache';
import {
    createDompetxClient,
    DompetxError,
    type DompetxClient,
} from '../billing/dompetx_client';
import {
    createPricingEngine,
    PricingRuleNotFoundError,
    UnknownActionError,
    type PricingEngine,
} from '../billing/pricing_engine';
import {
    createWalletService,
    InsufficientCreditError,
    type WalletService,
} from '../billing/wallet_service';
import { getFreeQuotaStatus } from '../billing/freemium';
import type {
    PaymentChannelQuote,
    TopupRow,
    TopupStatus,
} from '../models/billing';
import { BILLING_TOPUP_STATUSES } from '../models/billing';

// ─── Dependency factories (overridable per request for testing) ──────────────

export interface BillingApiDeps {
    pricingEngine?: (c: Context<HonoCustomType>) => PricingEngine;
    walletService?: (c: Context<HonoCustomType>) => WalletService;
    channelCache?: (c: Context<HonoCustomType>) => ChannelCache;
    dompetxClient?: (c: Context<HonoCustomType>) => DompetxClient;
    abuseGuard?: AbuseGuard;
}

function resolvePricingEngine(
    c: Context<HonoCustomType>,
    deps: BillingApiDeps,
): PricingEngine {
    return deps.pricingEngine
        ? deps.pricingEngine(c)
        : createPricingEngine(c.env.DB);
}

function resolveWalletService(
    c: Context<HonoCustomType>,
    deps: BillingApiDeps,
): WalletService {
    return deps.walletService
        ? deps.walletService(c)
        : createWalletService(c.env.DB);
}

function resolveDompetxClient(
    c: Context<HonoCustomType>,
    deps: BillingApiDeps,
): DompetxClient {
    return deps.dompetxClient ? deps.dompetxClient(c) : createDompetxClient(c.env);
}

function resolveChannelCache(
    c: Context<HonoCustomType>,
    deps: BillingApiDeps,
): ChannelCache {
    if (deps.channelCache) return deps.channelCache(c);
    const client = resolveDompetxClient(c, deps);
    // Channel_Cache only calls `listChannels()`; wrap to satisfy the
    // looser DompetxChannel shape it expects (carries an index signature).
    const adapter: DompetxChannelClient = {
        listChannels: async (): Promise<CacheDompetxChannel[]> => {
            const channels = await client.listChannels();
            return channels.map((ch) => ({ ...ch }) as CacheDompetxChannel);
        },
    };
    return createChannelCache(c.env.DB, adapter);
}

function resolveAbuseGuard(deps: BillingApiDeps): AbuseGuard {
    return deps.abuseGuard ?? defaultAbuseGuard;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Parse a positive integer from a query string; returns fallback when invalid. */
function parsePositiveInt(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
    return n;
}

/** Clamp limit to [1, 100] enforcing the server-side cap from Req 3.2 / 8.1. */
function clampLimit(raw: string | undefined, defaultLimit = 20): number {
    const parsed = parsePositiveInt(raw, defaultLimit);
    return Math.min(parsed, 100);
}

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

/**
 * Read optional `expiry_minutes` from env vars; falls back to 30 per task 7.1.
 * Vars may be a string (common) or number.
 */
function getExpiryMinutes(env: Bindings): number {
    // Not formally declared in types.d.ts; read defensively via index access.
    const raw = (env as unknown as Record<string, unknown>).BILLING_TOPUP_EXPIRY_MINUTES;
    const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0) {
        return parsed;
    }
    return 30;
}

/** Translate Abuse_Guard + billing errors into HTTP responses with i18n messages. */
function handleAbuseError(
    c: Context<HonoCustomType>,
    err: unknown,
): Response | null {
    const msgs = i18n.getMessagesbyContext(c);

    if (err instanceof FingerprintRequiredError) {
        return c.json({ code: err.code, message: msgs.FingerprintRequiredMsg }, 400);
    }
    if (err instanceof RateLimitedError) {
        return c.json({ code: err.code, message: msgs.RateLimitedMsg }, 429);
    }
    if (err instanceof RateLimitUnavailableError) {
        return c.json({ code: err.code, message: msgs.RateLimitedMsg }, 503);
    }
    return null;
}

// ─── Route handlers ──────────────────────────────────────────────────────────

function registerWalletRoutes(app: Hono<HonoCustomType>, deps: BillingApiDeps) {
    /**
     * GET /user_api/wallet
     * Returns the authenticated user's wallet snapshot. Lazily creates the
     * wallet row on first call (Requirement 1.3).
     */
    app.get('/user_api/wallet', async (c) => {
        const { user_id } = c.get('userPayload');
        const wallet = await resolveWalletService(c, deps).ensureWallet(user_id);
        return c.json({
            balance_credit: wallet.balance_credit,
            balance_idr_ref: wallet.balance_idr_ref,
            updated_at: wallet.updated_at,
        });
    });

    /**
     * GET /user_api/wallet/ledger?limit=&cursor=
     * Returns a cursor-paginated ledger page ordered by created_at DESC.
     * `limit` is clamped to [1, 100] per Requirement 3.2.
     */
    app.get('/user_api/wallet/ledger', async (c) => {
        const { user_id } = c.get('userPayload');
        const limit = clampLimit(c.req.query('limit'));
        const cursor = c.req.query('cursor') || undefined;

        const wallet = resolveWalletService(c, deps);
        // Ensure wallet exists so ledger queries do not surprise the caller
        // when the row was never materialised.
        await wallet.ensureWallet(user_id);

        try {
            const page = await wallet.listLedger({ userId: user_id, limit, cursor });
            return c.json(page);
        } catch (err) {
            if (err instanceof Error && err.message === 'Invalid cursor') {
                const msgs = i18n.getMessagesbyContext(c);
                return c.json({ code: 'invalid_input', message: msgs.InvalidInputMsg }, 400);
            }
            throw err;
        }
    });
}

function registerDomainRoute(app: Hono<HonoCustomType>, deps: BillingApiDeps) {
    /**
     * GET /user_api/billing/domains
     * Returns every active allowed_domain with its `create_address` credit cost
     * resolved via Pricing_Engine. Used by the address-create UI to preview
     * pricing (Requirements 2.1, 2.3).
     */
    app.get('/user_api/billing/domains', async (c) => {
        const msgs = i18n.getMessagesbyContext(c);
        const pricing = resolvePricingEngine(c, deps);
        try {
            const rows = await pricing.listDomainCosts('create_address');
            return c.json(
                rows.map((r) => ({
                    domain: r.domain,
                    domain_suffix: r.domainSuffix,
                    credit_cost: r.creditCost,
                })),
            );
        } catch (err) {
            if (err instanceof UnknownActionError) {
                return c.json({ code: err.code, message: msgs.UnknownActionMsg }, 400);
            }
            if (err instanceof PricingRuleNotFoundError) {
                return c.json({ code: 'unknown_action', message: msgs.UnknownActionMsg }, 400);
            }
            throw err;
        }
    });
}


function registerFreeQuotaRoute(app: Hono<HonoCustomType>) {
    /**
     * GET /user_api/billing/free_quota
     * Returns the current user's freemium usage: { used, limit, remaining }.
     * Used by the frontend to show quota indicators and trigger topup CTAs.
     */
    app.get('/user_api/billing/free_quota', async (c) => {
        const { user_id } = c.get('userPayload');
        const { used, limit } = await getFreeQuotaStatus(c.env.DB, user_id);
        return c.json({
            used,
            limit,
            remaining: Math.max(0, limit - used),
            exhausted: used >= limit,
        });
    });
}
function registerTopupQuoteRoute(app: Hono<HonoCustomType>, deps: BillingApiDeps) {
    /**
     * POST /user_api/topup/quote { nominal }
     * → [{ channel_code, name, fee_bearer, estimated_fee, gross_amount, bonus_hint, ... }]
     *
     * Flow (Requirements 4.2, 4.3, 4.4, 10.2, 10.5, 11.5):
     *   1. Abuse_Guard.requireFingerprint + checkTopupQuote (30/min/user, fail-open on KV outage)
     *   2. Reject `nominal < min_topup_idr` with 400 nominal_below_minimum (NO DompetX call)
     *   3. Channel_Cache.listForQuote(nominal) — already-filtered eligible channels
     *   4. Annotate each entry with `bonus_hint=true` when nominal ≥ bonus_threshold_idr
     */
    app.post('/user_api/topup/quote', async (c) => {
        const msgs = i18n.getMessagesbyContext(c);
        const guard = resolveAbuseGuard(deps);

        try {
            await guard.requireFingerprint(c);
            await guard.checkTopupQuote(c);
        } catch (err) {
            const response = handleAbuseError(c, err);
            if (response) return response;
            throw err;
        }

        let body: { nominal?: unknown };
        try {
            body = await c.req.json();
        } catch {
            return c.json({ code: 'invalid_input', message: msgs.InvalidInputMsg }, 400);
        }

        const nominal = Number(body.nominal);
        if (!Number.isFinite(nominal) || !Number.isInteger(nominal) || nominal <= 0) {
            return c.json({ code: 'invalid_input', message: msgs.InvalidInputMsg }, 400);
        }

        const pricing = resolvePricingEngine(c, deps);
        const minTopup = await pricing.getNumber('min_topup_idr');

        // Req 4.3: short-circuit with HTTP 400 BEFORE touching DompetX.
        // Boundary: `nominal === minTopup` is valid (inclusive).
        if (nominal < minTopup) {
            return c.json(
                { code: 'nominal_below_minimum', message: msgs.NominalBelowMinimumMsg },
                400,
            );
        }

        const bonusThreshold = await pricing.getNumber('bonus_threshold_idr');
        const qualifiesForBonus = nominal >= bonusThreshold;

        const channels = await resolveChannelCache(c, deps).listForQuote(nominal, {
            // `c.executionCtx` may be undefined in some runtimes (tests); guard access.
            waitUntil: (p) => {
                const ctx = c.executionCtx;
                if (ctx && typeof ctx.waitUntil === 'function') {
                    ctx.waitUntil(p);
                }
            },
        });

        const annotated: PaymentChannelQuote[] = channels.map((ch) => ({
            ...ch,
            bonus_hint: qualifiesForBonus,
        }));

        return c.json(annotated);
    });
}

function registerTopupCreateRoute(app: Hono<HonoCustomType>, deps: BillingApiDeps) {
    /**
     * POST /user_api/topup/create { nominal, channel_code }
     * → { invoice_id, checkout_url, expires_at, amount, voucher_code, discount_amount, fee, gross_amount }
     *
     * Flow (Requirements 4.6, 4.7, 4.8, 4.9, 10.1, 10.5):
     *   1. requireFingerprint + checkTopupCreate (5/10min + IP new-user guard,
     *      fail-closed on KV outage)
     *   2. nominal ≥ min_topup_idr
     *   3. channel_code resolves to an eligible cached channel for this nominal
     *   4. INSERT topup_transactions row (status='pending') with a temporary
     *      local invoice_id placeholder so we have a persistent audit trail
     *      even if the DompetX call fails
     *   5. Call DompetxClient.createInvoice
     *   6a. Success → UPDATE invoice_id, provider_reference, checkout_url and
     *       return the user-facing summary
     *   6b. Failure → UPDATE status='cancelled' and return 502 dompetx_unavailable
     */
    app.get('/user_api/billing/voucher/check', async (c) => {
        const code = c.req.query('code')?.trim();
        const nominalStr = c.req.query('nominal')?.trim();
        if (!code || !nominalStr) {
            return c.json({ valid: false, message: 'Kode atau nominal tidak valid' });
        }
        const nominal = Number(nominalStr);

        const voucher = await c.env.DB.prepare(
            `SELECT id, type, value, max_uses, uses, expires_at FROM vouchers WHERE code = ? AND is_active = 1`
        ).bind(code).first<{id: number, type: string, value: number, max_uses: number, uses: number, expires_at: string|null}>();

        if (!voucher) {
            return c.json({ valid: false, message: 'Voucher tidak valid atau tidak aktif.' });
        }
        if (voucher.uses >= voucher.max_uses) {
            return c.json({ valid: false, message: 'Voucher sudah mencapai batas penggunaan.' });
        }
        if (voucher.expires_at && new Date(voucher.expires_at) < new Date()) {
            return c.json({ valid: false, message: 'Voucher sudah kedaluwarsa.' });
        }

        let discountAmount = 0;
        if (voucher.type === 'free_credit') {
            discountAmount = nominal;
        } else if (voucher.type === 'discount_nominal') {
            discountAmount = voucher.value;
        } else if (voucher.type === 'discount_percent') {
            discountAmount = Math.floor(nominal * (voucher.value / 100));
        }
        
        if (discountAmount > nominal) {
            discountAmount = nominal;
        }

        return c.json({ valid: true, discountAmount });
    });

    app.post('/user_api/topup/create', async (c) => {
        const msgs = i18n.getMessagesbyContext(c);
        const { user_id } = c.get('userPayload');
        const guard = resolveAbuseGuard(deps);

        try {
            await guard.requireFingerprint(c);
            await guard.checkTopupCreate(c);
        } catch (err) {
            const response = handleAbuseError(c, err);
            if (response) return response;
            throw err;
        }

        const fingerprintHash = c.get('fingerprint_hash') ?? null;

        let body: { nominal?: unknown; channel_code?: unknown };
        try {
            body = await c.req.json();
        } catch {
            return c.json({ code: 'invalid_input', message: msgs.InvalidInputMsg }, 400);
        }

        const nominal = Number(body.nominal);
        const channelCode = typeof body.channel_code === 'string' ? body.channel_code : '';
        const voucherCode = typeof (body as any).voucher_code === 'string' ? (body as any).voucher_code.trim() : '';

        if (!Number.isFinite(nominal) || !Number.isInteger(nominal) || nominal <= 0) {
            return c.json({ code: 'invalid_input', message: msgs.InvalidInputMsg }, 400);
        }
        if (!channelCode) {
            return c.json({ code: 'invalid_input', message: msgs.InvalidInputMsg }, 400);
        }

        const pricing = resolvePricingEngine(c, deps);
        const minTopup = await pricing.getNumber('min_topup_idr');
        if (nominal < minTopup) {
            return c.json(
                { code: 'nominal_below_minimum', message: msgs.NominalBelowMinimumMsg },
                400,
            );
        }

        // Validate channel_code against the list of channels eligible for this
        // nominal. Using listForQuote() ensures we apply the same is_active +
        // min/max filter as the quote endpoint (Requirement 4.4).
        const eligibleChannels = await resolveChannelCache(c, deps).listForQuote(nominal);
        const selected = eligibleChannels.find((ch) => ch.channel_code === channelCode);
        if (!selected) {
            return c.json(
                { code: 'channel_not_eligible', message: msgs.ChannelNotEligibleMsg },
                400,
            );
        }

        const fee = selected.estimated_fee;
        let grossAmount = selected.gross_amount;
        const feeBearer = selected.fee_bearer;
        const expiryMinutes = getExpiryMinutes(c.env);
        const ip = getClientIp(c);

        let discountAmount = 0;
        let isFree = false;
        let voucherId = null;

        if (voucherCode) {
            const voucher = await c.env.DB.prepare(
                `SELECT id, type, value, max_uses, uses, expires_at FROM vouchers WHERE code = ? AND is_active = 1`
            ).bind(voucherCode).first<{id: number, type: string, value: number, max_uses: number, uses: number, expires_at: string|null}>();

            if (!voucher) {
                return c.json({ code: 'invalid_voucher', message: 'Voucher tidak valid atau sudah tidak aktif.' }, 400);
            }
            if (voucher.uses >= voucher.max_uses) {
                return c.json({ code: 'voucher_limit_reached', message: 'Voucher sudah mencapai batas penggunaan.' }, 400);
            }
            if (voucher.expires_at && new Date(voucher.expires_at) < new Date()) {
                return c.json({ code: 'voucher_expired', message: 'Voucher sudah kedaluwarsa.' }, 400);
            }

            if (voucher.type === 'free_credit') {
                isFree = true;
                discountAmount = nominal;
                voucherId = voucher.id;
            } else if (voucher.type === 'discount_nominal') {
                discountAmount = voucher.value;
                voucherId = voucher.id;
            } else if (voucher.type === 'discount_percent') {
                discountAmount = Math.floor(nominal * (voucher.value / 100));
                voucherId = voucher.id;
            }
            
            if (discountAmount > grossAmount) {
                discountAmount = grossAmount;
            }
            grossAmount = grossAmount - discountAmount;
            if (grossAmount <= 0) isFree = true;
        }

        if (isFree) {
            const walletService = resolveWalletService(c, deps);
            await c.env.DB.prepare(`UPDATE vouchers SET uses = uses + 1 WHERE id = ?`).bind(voucherId).run();
            const pricingRules = await resolvePricingEngine(c, deps).getAll();
            const { creditIdrRate } = resolvePricingConfig(c.env, pricingRules);
            const creditDelta = Math.floor(nominal / creditIdrRate);
            
            await walletService.creditVoucher({
                userId: user_id,
                creditDelta,
                voucherCode
            });
            
            return c.json({
                invoice_id: `voucher-${voucherCode}-${Date.now()}`,
                amount: nominal,
                fee: 0,
                gross_amount: 0,
                status: 'paid',
                is_free: true
            });
        }

        // ── Step 1: INSERT pending row with a local placeholder invoice_id ──
        // Using a `local-` prefix so the placeholder cannot collide with any
        // real DompetX invoice id (which never carries this prefix) and the
        // UNIQUE(invoice_id) guard still applies to both states.
        const localInvoiceId = `local-${crypto.randomUUID()}`;

        let pendingRowId: number;
        try {
            const insertResult = await c.env.DB.prepare(
                `INSERT INTO topup_transactions
                   (user_id, invoice_id, channel_code, amount, voucher_code, discount_amount, fee, gross_amount,
                    fee_bearer, status, fingerprint_hash, ip, expiry_minutes,
                    created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?,
                         datetime('now'), datetime('now'))
                 RETURNING id`,
            )
                .bind(
                    user_id ?? null,
                    localInvoiceId ?? null,
                    channelCode ?? null,
                    nominal ?? null,
                    voucherCode || null,
                    discountAmount ?? 0,
                    fee ?? null,
                    grossAmount ?? null,
                    feeBearer ?? null,
                    fingerprintHash ?? null,
                    ip ?? null,
                    expiryMinutes ?? null,
                )
                .first<{ id: number }>();

            if (!insertResult) {
                return c.text(msgs.OperationFailedMsg, 500);
            }
            pendingRowId = insertResult.id;
        } catch (err) {
            console.error('[billing] failed to insert pending topup row', err);
            return c.text(msgs.OperationFailedMsg, 500);
        }

        // ── Step 2: call DompetX createInvoice ──────────────────────────────
        const dompetx = resolveDompetxClient(c, deps);
        const webhookUrl = buildWebhookUrl(c);
        const returnUrl = c.req.header('x-topup-return-url') ?? undefined;

        if (grossAmount <= 0) {
            try {
                const wallet = createWalletService(c.env.DB);
                const pricing = resolvePricingEngine(c, deps);
                const [rate, threshold, bonus] = await Promise.all([
                    pricing.getNumber('credit_idr_rate'),
                    pricing.getNumber('bonus_threshold_idr'),
                    pricing.getNumber('bonus_rate_percent'),
                ]);
                await wallet.creditTopup({
                    userId: user_id, amountIdr: nominal,
                    creditIdrRate: rate, bonusThresholdIdr: threshold, bonusRatePercent: bonus,
                    invoiceId: localInvoiceId,
                });
                await c.env.DB.prepare(`UPDATE topup_transactions SET status = 'paid', paid_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).bind(pendingRowId).run();
                return c.json({ is_free: true, amount: nominal });
            } catch (err) {
                console.error('[billing] free topup failed', err);
                return c.text(msgs.OperationFailedMsg, 500);
            }
        }

        let invoice: Awaited<ReturnType<DompetxClient['createInvoice']>>;
        try {
            console.log('[billing] createInvoice payload', { nominal, grossAmount, discountAmount, channelCode, user_id });
            invoice = await dompetx.createInvoice({
                amount: grossAmount,
                channel_code: channelCode,
                fee_bearer: feeBearer,
                metadata: {
                    user_id,
                    local_invoice_id: localInvoiceId,
                    topup_row_id: pendingRowId,
                },
                webhook_url: webhookUrl,
                return_url: returnUrl,
            });
        } catch (err) {
            // Mark the pending row cancelled so downstream reconciler / audit
            // can see the failure without leaving a stuck row.
            try {
                await c.env.DB.prepare(
                    `UPDATE topup_transactions
                       SET status = 'cancelled', updated_at = datetime('now')
                     WHERE id = ? AND status = 'pending'`,
                )
                    .bind(pendingRowId)
                    .run();
            } catch (updateErr) {
                console.error('[billing] failed to mark pending row cancelled', updateErr);
            }

            const code =
                err instanceof DompetxError ? err.code : 'dompetx_unavailable';
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[billing] DompetX createInvoice FAILED', {
                user_id,
                pendingRowId,
                code,
                errMsg,
                nominal,
                grossAmount,
                discountAmount,
                channelCode,
            });
            return c.json(
                { code, message: errMsg || msgs.OperationFailedMsg },
                502,
            );
        }

        // ── Step 3: UPDATE row with DompetX invoice details ─────────────────
        // DompetX may return updated `fee` / `gross_amount` (e.g. when the
        // provider recalculates them); prefer those over our estimates.
        const finalFee = Number.isFinite(invoice.fee) ? invoice.fee : fee;
        const finalGross = Number.isFinite(invoice.gross_amount)
            ? invoice.gross_amount
            : grossAmount;
        const finalExpiryMinutes =
            Number.isFinite(invoice.expiry_minutes) && invoice.expiry_minutes > 0
                ? invoice.expiry_minutes
                : expiryMinutes;

        try {
            await c.env.DB.prepare(
                `UPDATE topup_transactions
                   SET invoice_id = ?,
                       provider_reference = ?,
                       checkout_url = ?,
                       fee = ?,
                       gross_amount = ?,
                       expiry_minutes = ?,
                       updated_at = datetime('now')
                 WHERE id = ?`,
            )
                .bind(
                    invoice.invoice_id ?? null,
                    invoice.provider_reference ?? null,
                    invoice.checkout_url ?? null,
                    finalFee ?? 0,
                    finalGross ?? 0,
                    finalExpiryMinutes ?? 30,
                    pendingRowId ?? null,
                )
                .run();
        } catch (err) {
            // If the UPDATE conflicts (e.g. DompetX returned a duplicated
            // invoice_id), surface 409 duplicate_invoice per the error table.
            const message = err instanceof Error ? err.message.toLowerCase() : '';
            if (message.includes('unique')) {
                return c.json(
                    { code: 'duplicate_invoice', message: msgs.DuplicateInvoiceMsg },
                    409,
                );
            }
            console.error('[billing] failed to update topup row with invoice', err);
            return c.text(msgs.OperationFailedMsg, 500);
        }

        // Compute `expires_at` relative to the creation timestamp of the row.
        // We read it back so the value we return matches what the reconciler
        // will treat as expiry.
        const row = await c.env.DB.prepare(
            `SELECT created_at FROM topup_transactions WHERE id = ?`,
        )
            .bind(pendingRowId)
            .first<{ created_at: string }>();

        const createdAtMs = row ? new Date(row.created_at).getTime() : Date.now();
        const expiresAt = new Date(
            createdAtMs + finalExpiryMinutes * 60 * 1000,
        ).toISOString();

        return c.json({
            invoice_id: invoice.invoice_id,
            checkout_url: invoice.checkout_url,
            expires_at: expiresAt,
            amount: nominal,
            fee: finalFee,
            gross_amount: finalGross,
        });
    });
}

function registerTopupHistoryRoute(app: Hono<HonoCustomType>, deps: BillingApiDeps) {
    /**
     * GET /user_api/topup/history?limit=&cursor=&status=
     * Returns the authenticated user's top-up transactions ordered by
     * created_at DESC with cursor pagination (Requirements 8.1, 8.2).
     *
     * `limit` is clamped to [1, 100]; `status` filter is validated against
     * the canonical set from `BILLING_TOPUP_STATUSES`.
     */
    app.get('/user_api/topup/history', async (c) => {
        const msgs = i18n.getMessagesbyContext(c);
        const { user_id } = c.get('userPayload');
        const limit = clampLimit(c.req.query('limit'));
        const cursor = c.req.query('cursor') || undefined;
        const statusFilter = c.req.query('status');

        if (statusFilter !== undefined && statusFilter !== '') {
            if (!BILLING_TOPUP_STATUSES.includes(statusFilter as TopupStatus)) {
                return c.json(
                    { code: 'invalid_input', message: msgs.InvalidInputMsg },
                    400,
                );
            }
        }

        let cursorParsed: { created_at: string; id: number } | null = null;
        if (cursor) {
            try {
                const decoded = atob(cursor);
                const payload = JSON.parse(decoded) as {
                    created_at?: unknown;
                    id?: unknown;
                };
                if (
                    typeof payload.created_at !== 'string' ||
                    typeof payload.id !== 'number'
                ) {
                    throw new Error('invalid cursor payload');
                }
                cursorParsed = { created_at: payload.created_at, id: payload.id };
            } catch {
                return c.json({ code: 'invalid_input', message: msgs.InvalidInputMsg }, 400);
            }
        }

        // Build query dynamically but keep bindings positional.
        const wheres: string[] = ['user_id = ?'];
        const bindings: (string | number)[] = [user_id];

        if (statusFilter) {
            wheres.push('status = ?');
            bindings.push(statusFilter);
        }
        if (cursorParsed) {
            wheres.push('(created_at < ? OR (created_at = ? AND id < ?))');
            bindings.push(cursorParsed.created_at, cursorParsed.created_at, cursorParsed.id);
        }

        const query = `
            SELECT id, user_id, invoice_id, provider_reference, channel_code,
                   amount, voucher_code, discount_amount, fee, gross_amount, fee_bearer, status, checkout_url,
                   expiry_minutes, fingerprint_hash, ip, raw_payload,
                   created_at, paid_at, updated_at
              FROM topup_transactions
             WHERE ${wheres.join(' AND ')}
             ORDER BY created_at DESC, id DESC
             LIMIT ?
        `;
        bindings.push(limit + 1);

        const { results } = await c.env.DB.prepare(query)
            .bind(...bindings)
            .all<TopupRow>();

        const rows = results ?? [];
        const hasMore = rows.length > limit;
        const items = (hasMore ? rows.slice(0, limit) : rows).map(sanitizeTopupRow);

        let next_cursor: string | null = null;
        if (hasMore && items.length > 0) {
            const last = items[items.length - 1];
            next_cursor = btoa(
                JSON.stringify({ created_at: last.created_at, id: last.id }),
            );
        }

        return c.json({ items, next_cursor });
    });
}

/**
 * Remove server-side-only fields from a topup row before returning it to the
 * user. `raw_payload` and `fingerprint_hash` are internal and may contain
 * (masked) gateway data; only admins see those via /admin/billing/... (Req 15.5).
 */
function sanitizeTopupRow(row: TopupRow): Omit<TopupRow, 'raw_payload' | 'fingerprint_hash'> {
    // Destructure the private fields off and keep the rest.
    const { raw_payload, fingerprint_hash, ...safe } = row;
    void raw_payload;
    void fingerprint_hash;
    return safe;
}

/**
 * Construct the DompetX webhook callback URL. Prefers an explicit override
 * from env (useful for preview deployments); otherwise derives from the
 * current request's origin.
 */
function buildWebhookUrl(c: Context<HonoCustomType>): string {
    const envOverride = (c.env as unknown as Record<string, unknown>).BILLING_WEBHOOK_URL;
    if (typeof envOverride === 'string' && envOverride.length > 0) {
        return envOverride;
    }
    const url = new URL(c.req.url);
    return `${url.origin}/open_api/payment/webhook/dompetx`;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Build a Hono app exposing the user-facing Billing_API routes. The returned
 * app is intended to be mounted via `app.route('/', billing)` in
 * `user_api/index.ts` so that the existing `/user_api/*` JWT middleware
 * protects every route in this module.
 *
 * Pass `deps` to inject alternative services during tests (e.g. a mock
 * DompetxClient); omitted dependencies are constructed per request from
 * `c.env` so each handler works against the current request's bindings.
 */
export function createBillingApi(
    deps: BillingApiDeps = {},
): Hono<HonoCustomType> {
    const app = new Hono<HonoCustomType>();

    registerWalletRoutes(app, deps);
    registerFreeQuotaRoute(app);
    registerDomainRoute(app, deps);
    registerTopupQuoteRoute(app, deps);
    registerTopupCreateRoute(app, deps);
    registerTopupHistoryRoute(app, deps);

    // InsufficientCreditError can bubble up from downstream calls if this
    // module is ever extended to debit credits directly. Currently none of
    // these routes debit, but we expose the mapping here as a guard so
    // future additions do not regress.
    app.onError((err, c) => {
        const msgs = i18n.getMessagesbyContext(c);
        if (err instanceof InsufficientCreditError) {
            return c.json({ code: err.code, message: msgs.InsufficientCreditMsg }, 402);
        }
        if (err instanceof UnknownActionError || err instanceof PricingRuleNotFoundError) {
            return c.json(
                { code: 'unknown_action', message: msgs.UnknownActionMsg },
                400,
            );
        }
        // Fall through — let the global handler surface the 500.
        throw err;
    });

    return app;
}

/** Default app built with lazy per-request dependency resolution. */
const billing = createBillingApi();
export default billing;
