/**
 * User-facing Billing_API — wallet, ledger, top-up, domain preview.
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

// ─── Dependency factories ───────────────────────────────────────────────────

export interface BillingApiDeps {
    pricingEngine?: (c: Context<HonoCustomType>) => PricingEngine;
    walletService?: (c: Context<HonoCustomType>) => WalletService;
    channelCache?: (c: Context<HonoCustomType>) => ChannelCache;
    dompetxClient?: (c: Context<HonoCustomType>) => DompetxClient;
    abuseGuard?: AbuseGuard;
}

function resolvePricingEngine(c: Context<HonoCustomType>, deps: BillingApiDeps): PricingEngine {
    return deps.pricingEngine ? deps.pricingEngine(c) : createPricingEngine(c.env.DB);
}

function resolveWalletService(c: Context<HonoCustomType>, deps: BillingApiDeps): WalletService {
    return deps.walletService ? deps.walletService(c) : createWalletService(c.env.DB);
}

function resolveDompetxClient(c: Context<HonoCustomType>, deps: BillingApiDeps): DompetxClient {
    return deps.dompetxClient ? deps.dompetxClient(c) : createDompetxClient(c.env);
}

function resolveChannelCache(c: Context<HonoCustomType>, deps: BillingApiDeps): ChannelCache {
    if (deps.channelCache) return deps.channelCache(c);
    const client = resolveDompetxClient(c, deps);
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

function parsePositiveInt(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
    return n;
}

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

function getExpiryMinutes(env: Bindings): number {
    const raw = (env as unknown as Record<string, unknown>).BILLING_TOPUP_EXPIRY_MINUTES;
    const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0) return parsed;
    return 30;
}

function handleAbuseError(c: Context<HonoCustomType>, err: unknown): Response | null {
    const msgs = i18n.getMessagesbyContext(c);
    if (err instanceof FingerprintRequiredError) return c.json({ code: err.code, message: msgs.FingerprintRequiredMsg }, 400);
    if (err instanceof RateLimitedError) return c.json({ code: err.code, message: msgs.RateLimitedMsg }, 429);
    if (err instanceof RateLimitUnavailableError) return c.json({ code: err.code, message: msgs.RateLimitedMsg }, 503);
    return null;
}

// ─── Route handlers ──────────────────────────────────────────────────────────

function registerWalletRoutes(app: Hono<HonoCustomType>, deps: BillingApiDeps) {
    app.get('/user_api/wallet', async (c) => {
        const { user_id } = c.get('userPayload');
        const wallet = await resolveWalletService(c, deps).ensureWallet(user_id);
        return c.json({
            balance_credit: wallet.balance_credit,
            balance_idr_ref: wallet.balance_idr_ref,
            updated_at: wallet.updated_at,
        });
    });

    app.get('/user_api/wallet/ledger', async (c) => {
        const { user_id } = c.get('userPayload');
        const limit = clampLimit(c.req.query('limit'));
        const cursor = c.req.query('cursor') || undefined;
        const wallet = resolveWalletService(c, deps);
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
    app.get('/user_api/billing/domains', async (c) => {
        const msgs = i18n.getMessagesbyContext(c);
        const pricing = resolvePricingEngine(c, deps);
        try {
            const rows = await pricing.listDomainCosts('create_address');
            return c.json(rows.map((r) => ({ domain: r.domain, domain_suffix: r.domainSuffix, credit_cost: r.creditCost })));
        } catch (err) {
            const code = (err instanceof PricingRuleNotFoundError || err instanceof UnknownActionError) ? 'unknown_action' : 'error';
            return c.json({ code, message: msgs.UnknownActionMsg }, 400);
        }
    });
}

function registerFreeQuotaRoute(app: Hono<HonoCustomType>) {
    app.get('/user_api/billing/free_quota', async (c) => {
        const { user_id } = c.get('userPayload');
        const { used, limit } = await getFreeQuotaStatus(c.env.DB, user_id);
        return c.json({ used, limit, remaining: Math.max(0, limit - used), exhausted: used >= limit });
    });
}

function registerTopupQuoteRoute(app: Hono<HonoCustomType>, deps: BillingApiDeps) {
    app.post('/topup/quote', async (c) => {
        const msgs = i18n.getMessagesbyContext(c);
        const guard = resolveAbuseGuard(deps);
        try {
            await guard.requireFingerprint(c);
            await guard.checkTopupQuote(c);
        } catch (err) {
            const res = handleAbuseError(c, err);
            if (res) return res;
            throw err;
        }
        let body: any;
        try { body = await c.req.json(); } catch { return c.json({ code: 'invalid_input', message: msgs.InvalidInputMsg }, 400); }
        const nominal = Number(body.nominal);
        if (!Number.isFinite(nominal) || nominal <= 0) return c.json({ code: 'invalid_input', message: msgs.InvalidInputMsg }, 400);
        const pricing = resolvePricingEngine(c, deps);
        const minTopup = await pricing.getNumber('min_topup_idr');
        if (nominal < minTopup) return c.json({ code: 'nominal_below_minimum', message: msgs.NominalBelowMinimumMsg }, 400);
        const bonusThreshold = await pricing.getNumber('bonus_threshold_idr');
        const qualifiesForBonus = nominal >= bonusThreshold;
        const channels = await resolveChannelCache(c, deps).listForQuote(nominal);
        return c.json(channels.map(ch => ({ ...ch, bonus_hint: qualifiesForBonus })));
    });
}

function registerTopupCreateRoute(app: Hono<HonoCustomType>, deps: BillingApiDeps) {
    app.get('/voucher/check', async (c) => {
        const code = c.req.query('code')?.trim();
        const nominalStr = c.req.query('nominal')?.trim();
        if (!code || !nominalStr) return c.json({ valid: false, message: 'Invalid input' });
        const nominal = Number(nominalStr);
        const voucher = await c.env.DB.prepare(`SELECT * FROM vouchers WHERE code = ? AND is_active = 1`).bind(code).first<any>();
        if (!voucher) return c.json({ valid: false, message: 'Voucher tidak valid' });
        let discount = 0;
        if (voucher.type === 'free_credit') discount = nominal;
        else if (voucher.type === 'discount_nominal') discount = voucher.value;
        else if (voucher.type === 'discount_percent') discount = Math.floor(nominal * (voucher.value / 100));
        return c.json({ valid: true, discountAmount: Math.min(discount, nominal) });
    });

    app.post('/topup/create', async (c) => {
        const msgs = i18n.getMessagesbyContext(c);
        const { user_id } = c.get('userPayload');
        const guard = resolveAbuseGuard(deps);

        try {
            await guard.requireFingerprint(c);
            await guard.checkTopupCreate(c);
        } catch (err) {
            const res = handleAbuseError(c, err);
            if (res) return res;
            throw err;
        }

        let body: any;
        try { body = await c.req.json(); } catch { return c.json({ code: 'invalid_input', message: msgs.InvalidInputMsg }, 400); }
        
        const nominal = Number(body.nominal);
        const channelCode = typeof body.channel_code === 'string' ? body.channel_code : '';
        const voucherCode = typeof body.voucher_code === 'string' ? body.voucher_code.trim() : '';

        if (!Number.isFinite(nominal) || nominal <= 0) return c.json({ code: 'invalid_input', message: msgs.InvalidInputMsg }, 400);

        const pricing = resolvePricingEngine(c, deps);
        const minTopup = await pricing.getNumber('min_topup_idr');
        if (nominal < minTopup) return c.json({ code: 'nominal_below_minimum', message: msgs.NominalBelowMinimumMsg }, 400);

        // --- STEP 1: CALCULATE DISCOUNT & CHECK IF FREE ---
        let discountAmount = 0;
        let voucherId = null;
        if (voucherCode) {
            const v = await c.env.DB.prepare(`SELECT id, type, value, max_uses, uses, expires_at FROM vouchers WHERE code = ? AND is_active = 1`).bind(voucherCode).first<any>();
            if (v && v.uses < v.max_uses && (!v.expires_at || new Date(v.expires_at) >= new Date())) {
                voucherId = v.id;
                if (v.type === 'free_credit') discountAmount = nominal;
                else if (v.type === 'discount_nominal') discountAmount = v.value;
                else if (v.type === 'discount_percent') discountAmount = Math.floor(nominal * (v.value / 100));
            }
        }

        const isFree = discountAmount >= nominal;
        let selected: any = null;
        if (!isFree) {
            if (!channelCode) return c.json({ code: 'invalid_input', message: 'Metode pembayaran wajib dipilih' }, 400);
            const channels = await resolveChannelCache(c, deps).listForQuote(nominal);
            selected = channels.find(ch => ch.channel_code === channelCode);
            if (!selected) return c.json({ code: 'channel_not_eligible', message: msgs.ChannelNotEligibleMsg }, 400);
        }

        const grossAmount = isFree ? 0 : Math.max(0, (selected?.gross_amount ?? nominal) - discountAmount);
        const localInvoiceId = `local-${crypto.randomUUID()}`;
        const fingerprintHash = c.get('fingerprint_hash') ?? null;
        const ip = getClientIp(c);
        const expiryMinutes = getExpiryMinutes(c.env);

        // --- STEP 2: CREATE PENDING TRANSACTION ---
        const { id: pendingRowId } = await c.env.DB.prepare(
            `INSERT INTO topup_transactions (user_id, invoice_id, channel_code, amount, voucher_code, discount_amount, fee, gross_amount, fee_bearer, status, fingerprint_hash, ip, expiry_minutes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, datetime('now'), datetime('now')) RETURNING id`
        ).bind(user_id, localInvoiceId, channelCode || 'VOUCHER', nominal, voucherCode, discountAmount, selected?.estimated_fee ?? 0, grossAmount, selected?.fee_bearer ?? 'customer', fingerprintHash, ip, expiryMinutes).first<any>();

        // --- STEP 3: HANDLE FREE TOPUP (STOP HERE) ---
        if (isFree || grossAmount <= 0) {
            try {
                const wallet = resolveWalletService(c, deps);
                const pricingEngine = resolvePricingEngine(c, deps);
                const [rate, threshold, bonus] = await Promise.all([pricingEngine.getNumber('credit_idr_rate'), pricingEngine.getNumber('bonus_threshold_idr'), pricingEngine.getNumber('bonus_rate_percent')]);
                await wallet.creditTopup({ userId: user_id, amountIdr: nominal, creditIdrRate: rate, bonusThresholdIdr: threshold, bonusRatePercent: bonus, invoiceId: localInvoiceId });
                if (voucherId) await c.env.DB.prepare(`UPDATE vouchers SET uses = uses + 1 WHERE id = ?`).bind(voucherId).run();
                await c.env.DB.prepare(`UPDATE topup_transactions SET status = 'paid', paid_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).bind(pendingRowId).run();
                return c.json({ is_free: true, amount: nominal, invoice_id: localInvoiceId });
            } catch (err) {
                console.error('[free-topup] error', err);
                return c.text(msgs.OperationFailedMsg, 500);
            }
        }

        // --- STEP 4: CALL PAYMENT GATEWAY ---
        try {
            const dompetx = resolveDompetxClient(c, deps);
            const invoice = await dompetx.createInvoice({
                amount: grossAmount,
                channel_code: channelCode,
                fee_bearer: selected?.fee_bearer ?? 'customer',
                metadata: { user_id, local_invoice_id: localInvoiceId, topup_row_id: pendingRowId },
                webhook_url: buildWebhookUrl(c),
            });

            await c.env.DB.prepare(
                `UPDATE topup_transactions SET invoice_id = ?, provider_reference = ?, checkout_url = ?, fee = ?, gross_amount = ?, updated_at = datetime('now') WHERE id = ?`
            ).bind(invoice.invoice_id, invoice.provider_reference, invoice.checkout_url, invoice.fee, invoice.gross_amount, pendingRowId).run();

            return c.json({
                invoice_id: invoice.invoice_id,
                checkout_url: invoice.checkout_url,
                amount: nominal,
                gross_amount: invoice.gross_amount,
                expires_at: new Date(Date.now() + (invoice.expiry_minutes || 30) * 60000).toISOString()
            });
        } catch (err) {
            await c.env.DB.prepare(`UPDATE topup_transactions SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`).bind(pendingRowId).run();
            const code = err instanceof DompetxError ? err.code : 'dompetx_unavailable';
            return c.json({ code, message: (err as Error).message || msgs.OperationFailedMsg }, 502);
        }
    });
}

function registerTopupHistoryRoute(app: Hono<HonoCustomType>) {
    app.get('/topup/history', async (c) => {
        const { user_id } = c.get('userPayload');
        const limit = clampLimit(c.req.query('limit'));
        const { results } = await c.env.DB.prepare(`SELECT * FROM topup_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`).bind(user_id, limit).all<any>();
        return c.json({ items: results || [] });
    });
}

function buildWebhookUrl(c: Context<HonoCustomType>): string {
    const env = (c.env as any).BILLING_WEBHOOK_URL;
    if (env) return env;
    return `${new URL(c.req.url).origin}/open_api/payment/webhook/dompetx`;
}

export function createBillingApi(deps: BillingApiDeps = {}): Hono<HonoCustomType> {
    const app = new Hono<HonoCustomType>();
    registerWalletRoutes(app, deps);
    registerFreeQuotaRoute(app);
    registerDomainRoute(app, deps);
    registerTopupQuoteRoute(app, deps);
    registerTopupCreateRoute(app, deps);
    registerTopupHistoryRoute(app);
    return app;
}

export default createBillingApi();
