/**
 * DompetX payment gateway client
 * Feature: saas-topup-billing
 * Requirements: 4.6, 5.2, 8.4, 9.1, 15.1
 */

// ─── Error types ─────────────────────────────────────────────────────────────

export type DompetxErrorCode =
    | 'dompetx_unavailable'
    | 'dompetx_bad_request'
    | 'dompetx_unauthorized'
    | 'dompetx_not_found'
    | 'dompetx_timeout'
    | 'dompetx_unknown';

export class DompetxError extends Error {
    readonly code: DompetxErrorCode;
    readonly httpStatus: number | null;

    constructor(code: DompetxErrorCode, message: string, httpStatus: number | null = null) {
        super(message);
        this.name = 'DompetxError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

// ─── Request / Response shapes ────────────────────────────────────────────────

export interface CreateInvoiceRequest {
    amount: number;           // IDR nominal
    channel_code: string;
    fee_bearer: 'customer' | 'merchant';
    metadata?: Record<string, unknown>;
    webhook_url: string;
    return_url?: string;
}

export interface CreateInvoiceResponse {
    invoice_id: string;
    checkout_url: string;
    provider_reference: string | null;
    amount: number;
    fee: number;
    gross_amount: number;
    status: string;
    expiry_minutes: number;
}

export interface InvoiceStatusResponse {
    invoice_id: string;
    provider_reference: string | null;
    status: 'pending' | 'paid' | 'failed' | 'expired' | 'cancelled';
    amount: number;
    fee: number;
    gross_amount: number;
    paid_at: string | null;
    channel_code: string;
}

export interface DompetxChannel {
    channel_code: string;
    name: string;
    group: string;
    min: number;
    max: number | null;
    fee_type: 'percentage' | 'fixed' | 'mixed';
    fee_value: number;
    fee_fixed: number;
    fee_bearer: 'customer' | 'merchant';
    is_active: boolean;
    icon_url?: string;
}

// ─── Interface (for dependency injection / mocking in tests) ──────────────────

/**
 * Default anti-replay window for webhook timestamps, in seconds.
 * Requests with `|now - timestamp|` larger than this should be rejected.
 * See design.md §"Payment_Webhook" and Requirement 5.2.
 */
export const DOMPETX_WEBHOOK_TIMESTAMP_WINDOW_SECONDS = 300;

export interface DompetxClient {
    createInvoice(req: CreateInvoiceRequest): Promise<CreateInvoiceResponse>;
    getInvoiceStatus(invoiceId: string): Promise<InvoiceStatusResponse>;
    listChannels(): Promise<DompetxChannel[]>;
    verifyWebhookSignature(rawBody: string, timestamp: string, signatureHex: string): Promise<boolean>;
    /**
     * Check whether a webhook timestamp is within the allowed anti-replay window.
     * Defaults to ±300s (see DOMPETX_WEBHOOK_TIMESTAMP_WINDOW_SECONDS).
     *
     * @param timestamp     - Unix-seconds string from the `X-DompetX-Timestamp` header.
     * @param windowSeconds - Allowed skew in seconds (default 300).
     * @param nowSeconds    - Optional injected "now" in unix-seconds for testability.
     */
    isTimestampWithinWindow(
        timestamp: string,
        windowSeconds?: number,
        nowSeconds?: number,
    ): boolean;
}

// ─── Retry helpers ────────────────────────────────────────────────────────────

const RETRY_DELAYS_MS = [250, 750] as const;

/**
 * Returns a jittered delay: base ± 20% random jitter.
 */
function jitteredDelay(baseMs: number): number {
    const jitter = baseMs * 0.2 * (Math.random() * 2 - 1); // ±20%
    return Math.max(0, Math.round(baseMs + jitter));
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── HMAC-SHA256 helpers ──────────────────────────────────────────────────────

/**
 * Compute HMAC-SHA256 over `message` using `secret`, returning hex string.
 * Uses the Web Crypto API available in Cloudflare Workers.
 */
async function hmacSha256Hex(secret: string, message: string): Promise<string> {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const signature = await crypto.subtle.sign('HMAC', keyMaterial, enc.encode(message));
    return Array.from(new Uint8Array(signature))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Constant-time comparison of two hex strings to prevent timing attacks.
 * Falls back to a byte-by-byte comparison using XOR accumulation.
 */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
    const enc = new TextEncoder();
    const aBytes = enc.encode(a);
    const bBytes = enc.encode(b);

    // Lengths must match; if not, still do a full comparison to avoid timing leak
    if (aBytes.length !== bBytes.length) {
        // Run a dummy comparison to keep timing consistent
        let dummy = 0;
        for (let i = 0; i < aBytes.length; i++) {
            dummy |= aBytes[i] ^ (bBytes[i % bBytes.length] ?? 0);
        }
        return false;
    }

    let diff = 0;
    for (let i = 0; i < aBytes.length; i++) {
        diff |= aBytes[i] ^ bBytes[i];
    }
    return diff === 0;
}

// ─── Implementation ───────────────────────────────────────────────────────────

export class DompetxClientImpl implements DompetxClient {
    private readonly apiKey: string;
    private readonly apiSecret: string;
    private readonly webhookSecret: string;
    private readonly baseUrl: string;

    constructor(opts: {
        apiKey: string;
        apiSecret?: string;
        webhookSecret?: string;
        baseUrl?: string;
    }) {
        this.apiKey = opts.apiKey;
        // Per docs: apiKey is used as the secret for signature generation
        this.apiSecret = opts.apiSecret || opts.apiKey;
        this.webhookSecret = opts.webhookSecret || opts.apiKey;
        this.baseUrl = opts.baseUrl ?? 'https://api.dompetx.com/v1';
    }

    // ── Outbound request signing ──────────────────────────────────────────────

    /**
     * Build signed request headers for outbound DompetX API calls.
     * Signature = HMAC-SHA256(apiSecret, timestamp + "." + rawBody)
     */
    private async buildHeaders(rawBody: string): Promise<Record<string, string>> {
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signaturePayload = `${timestamp}.${rawBody}`;
        const signature = await hmacSha256Hex(this.apiSecret, signaturePayload);

        return {
            'Content-Type': 'application/json',
            'X-DOMPAY-API-Key': this.apiKey,
            'X-DOMPAY-Timestamp': timestamp,
            'X-DOMPAY-Signature': signature,
        };
    }

    // ── Fetch with retry ──────────────────────────────────────────────────────

    /**
     * Execute a fetch with up to 2 retries on 5xx responses.
     * Never retries on 4xx. Surfaces DompetxError on failure.
     */
    private async fetchWithRetry(
        url: string,
        init: RequestInit,
        rawBody: string,
    ): Promise<Response> {
        let lastError: DompetxError | null = null;

        for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
            // Rebuild signed headers on each attempt (fresh timestamp)
            const headers = await this.buildHeaders(rawBody);
            const mergedInit: RequestInit = {
                ...init,
                headers: { ...headers, ...(init.headers as Record<string, string> ?? {}) },
            };

            let response: Response;
            try {
                response = await fetch(url, mergedInit);
            } catch (err) {
                // Network-level error — treat as 5xx-equivalent
                lastError = new DompetxError(
                    'dompetx_unavailable',
                    `Network error calling DompetX: ${(err as Error).message}`,
                    null,
                );
                if (attempt < RETRY_DELAYS_MS.length) {
                    await sleep(jitteredDelay(RETRY_DELAYS_MS[attempt]));
                    continue;
                }
                throw lastError;
            }

            // 4xx — never retry
            if (response.status >= 400 && response.status < 500) {
                const code = this.mapHttpStatus(response.status);
                throw new DompetxError(code, `DompetX returned ${response.status}`, response.status);
            }

            // 5xx — retry up to limit
            if (response.status >= 500) {
                lastError = new DompetxError(
                    'dompetx_unavailable',
                    `DompetX returned ${response.status}`,
                    response.status,
                );
                if (attempt < RETRY_DELAYS_MS.length) {
                    await sleep(jitteredDelay(RETRY_DELAYS_MS[attempt]));
                    continue;
                }
                throw lastError;
            }

            // 2xx / 3xx — success
            return response;
        }

        // Should not reach here, but satisfy TypeScript
        throw lastError ?? new DompetxError('dompetx_unknown', 'Unknown DompetX error');
    }

    private mapHttpStatus(status: number): DompetxErrorCode {
        if (status === 400) return 'dompetx_bad_request';
        if (status === 401 || status === 403) return 'dompetx_unauthorized';
        if (status === 404) return 'dompetx_not_found';
        if (status >= 500) return 'dompetx_unavailable';
        return 'dompetx_unknown';
    }

    // ── Public API methods ────────────────────────────────────────────────────

    async createInvoice(req: CreateInvoiceRequest): Promise<CreateInvoiceResponse> {
        // Reverting to /payments (Direct Transaction) as requested, but with 502 fixes
        const dompayBody = {
            method: req.channel_code,
            amount: req.amount,
            currency: 'IDR',
            reference: req.metadata?.local_invoice_id || `inv_${Date.now()}`,
        };
        const rawBody = JSON.stringify(dompayBody);
        const response = await this.fetchWithRetry(
            `${this.baseUrl}/payments`,
            { method: 'POST', body: rawBody },
            rawBody,
        );

        const raw = await response.json() as any;
        const data = raw.data || raw;

        // Map back to our internal response shape with various fallbacks
        // DompetX Direct Payment might return paymentUrl, qr_url, or checkoutUrl
        const checkoutUrl = data.paymentUrl || data.payment_url || data.checkoutUrl || data.qr_url || data.pdf_url || null;

        return {
            invoice_id: data.reference || data.id || dompayBody.reference,
            checkout_url: checkoutUrl,
            provider_reference: data.id || null,
            amount: data.amount || dompayBody.amount,
            fee: data.fee || 0,
            gross_amount: data.totalAmount || data.amount || dompayBody.amount,
            status: data.status || 'pending',
            expiry_minutes: 60
        };
    }

    async getInvoiceStatus(invoiceId: string): Promise<InvoiceStatusResponse> {
        const rawBody = '';
        const response = await this.fetchWithRetry(
            `${this.baseUrl}/payments/${encodeURIComponent(invoiceId)}`,
            { method: 'GET' },
            rawBody,
        );

        const data = await response.json() as any;
        return {
            invoice_id: invoiceId,
            provider_reference: data.data?.id || null,
            status: data.data?.status || 'pending',
            amount: data.data?.amount || 0,
            fee: 0,
            gross_amount: data.data?.amount || 0,
            paid_at: data.data?.paidAt || null,
            channel_code: data.data?.method || ''
        };
    }

    async listChannels(): Promise<DompetxChannel[]> {
        const rawBody = '';
        const response = await this.fetchWithRetry(
            `${this.baseUrl}/payments/channel`,
            { method: 'GET' },
            rawBody,
        );

        const data = await response.json() as any;
        const channels = data.data || [];
        return channels.map((c: any) => ({
            channel_code: c.code,
            name: c.name,
            group: c.group || 'E-Wallet',
            min: c.minAmount || 1000,
            max: c.maxAmount || null,
            fee_type: 'fixed',
            fee_value: 0,
            fee_fixed: 0,
            fee_bearer: 'customer',
            is_active: true,
            icon_url: c.iconUrl
        }));
    }

    /**
     * Verify an inbound DompetX webhook signature.
     *
     * Expected signature: HMAC-SHA256(webhookSecret, timestamp + "." + rawBody)
     * Uses constant-time comparison to prevent timing attacks.
     *
     * @param rawBody     - The raw request body string (before JSON parsing)
     * @param timestamp   - The X-DompetX-Timestamp header value (unix seconds)
     * @param signatureHex - The X-DompetX-Signature header value (hex string)
     * @returns true if the signature is valid, false otherwise
     */
    async verifyWebhookSignature(
        rawBody: string,
        timestamp: string,
        signatureHex: string,
    ): Promise<boolean> {
        const signaturePayload = `${timestamp}.${rawBody}`;
        const expectedHex = await hmacSha256Hex(this.webhookSecret, signaturePayload);
        return timingSafeEqual(expectedHex, signatureHex);
    }

    /**
     * Verify that a webhook timestamp is within the ±`windowSeconds` anti-replay window.
     * Rejects non-numeric, NaN, or out-of-window values. Defaults to ±300s.
     */
    isTimestampWithinWindow(
        timestamp: string,
        windowSeconds: number = DOMPETX_WEBHOOK_TIMESTAMP_WINDOW_SECONDS,
        nowSeconds: number = Math.floor(Date.now() / 1000),
    ): boolean {
        if (typeof timestamp !== 'string' || timestamp.length === 0) return false;
        // Reject anything that isn't an integer representation (e.g. "12.5", "abc", "")
        if (!/^-?\d+$/.test(timestamp)) return false;
        const ts = Number(timestamp);
        if (!Number.isFinite(ts)) return false;
        if (!Number.isFinite(nowSeconds)) return false;
        return Math.abs(nowSeconds - ts) <= windowSeconds;
    }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a DompetxClient from Cloudflare Worker bindings.
 * Throws if any required secret is missing (Requirement 15.6).
 */
export function createDompetxClient(env: {
    DOMPETX_API_KEY?: string;
    DOMPETX_API_SECRET?: string;
    DOMPETX_WEBHOOK_SECRET?: string;
}): DompetxClient {
    if (!env.DOMPETX_API_KEY) {
        throw new Error('DOMPETX_API_KEY secret is not set');
    }

    return new DompetxClientImpl({
        apiKey: env.DOMPETX_API_KEY,
        apiSecret: env.DOMPETX_API_SECRET,
        webhookSecret: env.DOMPETX_WEBHOOK_SECRET,
    });
}
