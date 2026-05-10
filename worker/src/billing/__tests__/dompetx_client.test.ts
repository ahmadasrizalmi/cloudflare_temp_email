// Feature: saas-topup-billing — DompetX client unit tests
/**
 * Unit tests for the DompetX HTTP client.
 *
 * Validates: Requirements 5.2, 5.3, 15.4
 *
 * Coverage:
 *   - Signature verification accepts valid HMAC + timestamp within 300s
 *   - Rejects tampered body / timestamp / signature
 *   - createInvoice retries exactly twice on 5xx then throws DompetxError
 *   - createInvoice never retries on 4xx
 *   - Sensitive keys (api key, api secret, webhook secret) never appear
 *     in any console log arg or in thrown error messages
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    DompetxClientImpl,
    DompetxError,
    DOMPETX_WEBHOOK_TIMESTAMP_WINDOW_SECONDS,
    type CreateInvoiceRequest,
} from '../dompetx_client.js';

// ─── Test fixtures ────────────────────────────────────────────────────────────

const API_KEY = 'test_api_key_SUPER_SECRET_VALUE';
const API_SECRET = 'test_api_secret_VERY_SENSITIVE_DATA';
const WEBHOOK_SECRET = 'test_webhook_secret_DO_NOT_LEAK_ME';
const BASE_URL = 'https://api.example.test/v1';

function makeClient(): DompetxClientImpl {
    return new DompetxClientImpl({
        apiKey: API_KEY,
        apiSecret: API_SECRET,
        webhookSecret: WEBHOOK_SECRET,
        baseUrl: BASE_URL,
    });
}

/** Oracle: compute HMAC-SHA256 hex just like the client does internally. */
async function hmacSha256Hex(secret: string, message: string): Promise<string> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
    return Array.from(new Uint8Array(sig))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

const VALID_INVOICE_RESPONSE = {
    invoice_id: 'inv_1',
    checkout_url: 'https://pay.example.test/inv_1',
    provider_reference: null,
    amount: 10000,
    fee: 0,
    gross_amount: 10000,
    status: 'pending',
    expiry_minutes: 30,
};

const SAMPLE_CREATE_REQ: CreateInvoiceRequest = {
    amount: 10000,
    channel_code: 'QRIS',
    fee_bearer: 'customer',
    webhook_url: 'https://example.test/webhook',
};

// ─── verifyWebhookSignature ───────────────────────────────────────────────────

describe('DompetxClientImpl.verifyWebhookSignature', () => {
    it('accepts a valid HMAC signature over `timestamp.rawBody`', async () => {
        const client = makeClient();
        const body = JSON.stringify({ invoice_id: 'inv_1', status: 'paid' });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signaturePayload = `${timestamp}.${body}`;
        const sig = await hmacSha256Hex(WEBHOOK_SECRET, signaturePayload);

        const ok = await client.verifyWebhookSignature(body, timestamp, sig);
        expect(ok).toBe(true);
    });

    it('rejects a tampered body even if signature was valid for the original', async () => {
        const client = makeClient();
        const body = JSON.stringify({ invoice_id: 'inv_1', status: 'paid' });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const sig = await hmacSha256Hex(WEBHOOK_SECRET, `${timestamp}.${body}`);

        const tamperedBody = JSON.stringify({ invoice_id: 'inv_1', status: 'paid', extra: 'x' });
        const ok = await client.verifyWebhookSignature(tamperedBody, timestamp, sig);
        expect(ok).toBe(false);
    });

    it('rejects when the timestamp is altered (signature no longer matches)', async () => {
        const client = makeClient();
        const body = JSON.stringify({ invoice_id: 'inv_1', status: 'paid' });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const sig = await hmacSha256Hex(WEBHOOK_SECRET, `${timestamp}.${body}`);

        const differentTs = String(Number(timestamp) + 1);
        const ok = await client.verifyWebhookSignature(body, differentTs, sig);
        expect(ok).toBe(false);
    });

    it('rejects when the signature is flipped by one byte', async () => {
        const client = makeClient();
        const body = JSON.stringify({ invoice_id: 'inv_1' });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const sig = await hmacSha256Hex(WEBHOOK_SECRET, `${timestamp}.${body}`);

        const lastChar = sig.charAt(sig.length - 1);
        const flippedChar = lastChar === 'a' ? 'b' : 'a';
        const tamperedSig = sig.slice(0, -1) + flippedChar;

        const ok = await client.verifyWebhookSignature(body, timestamp, tamperedSig);
        expect(ok).toBe(false);
    });

    it('rejects a signature of a different length (e.g. truncated)', async () => {
        const client = makeClient();
        const body = JSON.stringify({ invoice_id: 'inv_1' });
        const timestamp = String(Math.floor(Date.now() / 1000));

        const ok = await client.verifyWebhookSignature(body, timestamp, 'deadbeef');
        expect(ok).toBe(false);
    });

    it('rejects a signature produced with a different webhook secret', async () => {
        const client = makeClient();
        const body = JSON.stringify({ invoice_id: 'inv_1' });
        const timestamp = String(Math.floor(Date.now() / 1000));

        // Sign with the wrong secret
        const sig = await hmacSha256Hex('WRONG_SECRET', `${timestamp}.${body}`);

        const ok = await client.verifyWebhookSignature(body, timestamp, sig);
        expect(ok).toBe(false);
    });
});

// ─── isTimestampWithinWindow ──────────────────────────────────────────────────

describe('DompetxClientImpl.isTimestampWithinWindow (±300s anti-replay window)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('exposes the default window as 300 seconds', () => {
        expect(DOMPETX_WEBHOOK_TIMESTAMP_WINDOW_SECONDS).toBe(300);
    });

    it('accepts timestamps within the 300-second window', () => {
        const client = makeClient();
        vi.setSystemTime(new Date(1_700_000_000_000));
        const nowSec = Math.floor(Date.now() / 1000);

        expect(client.isTimestampWithinWindow(String(nowSec))).toBe(true);
        expect(client.isTimestampWithinWindow(String(nowSec - 299))).toBe(true);
        expect(client.isTimestampWithinWindow(String(nowSec + 299))).toBe(true);
        // Boundary: exactly 300s is still "within" (|Δ| <= 300)
        expect(client.isTimestampWithinWindow(String(nowSec - 300))).toBe(true);
        expect(client.isTimestampWithinWindow(String(nowSec + 300))).toBe(true);
    });

    it('rejects timestamps outside the 300-second window', () => {
        const client = makeClient();
        vi.setSystemTime(new Date(1_700_000_000_000));
        const nowSec = Math.floor(Date.now() / 1000);

        expect(client.isTimestampWithinWindow(String(nowSec - 301))).toBe(false);
        expect(client.isTimestampWithinWindow(String(nowSec + 301))).toBe(false);
        expect(client.isTimestampWithinWindow(String(nowSec - 10_000))).toBe(false);
        expect(client.isTimestampWithinWindow(String(nowSec + 10_000))).toBe(false);
    });

    it('rejects malformed or non-integer timestamps', () => {
        const client = makeClient();
        vi.setSystemTime(new Date(1_700_000_000_000));

        expect(client.isTimestampWithinWindow('')).toBe(false);
        expect(client.isTimestampWithinWindow('abc')).toBe(false);
        expect(client.isTimestampWithinWindow('12.5')).toBe(false);
        expect(client.isTimestampWithinWindow('NaN')).toBe(false);
        expect(client.isTimestampWithinWindow(' 123 ')).toBe(false);
    });

    it('honours a custom window size argument', () => {
        const client = makeClient();
        vi.setSystemTime(new Date(1_700_000_000_000));
        const nowSec = Math.floor(Date.now() / 1000);

        expect(client.isTimestampWithinWindow(String(nowSec - 60), 30)).toBe(false);
        expect(client.isTimestampWithinWindow(String(nowSec - 10), 30)).toBe(true);
    });
});

// ─── createInvoice retry behaviour ────────────────────────────────────────────

describe('DompetxClientImpl.createInvoice retry behaviour', () => {
    beforeEach(() => {
        // Make the retry backoff `sleep()` immediate so tests don't block on timers.
        // The client uses `setTimeout(resolve, ms)` inside its sleep() helper.
        vi.stubGlobal(
            'setTimeout',
            ((fn: () => void) => {
                queueMicrotask(fn);
                return 0 as unknown as ReturnType<typeof setTimeout>;
            }) as unknown as typeof setTimeout,
        );
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('retries exactly twice on 5xx (3 total attempts) and then throws DompetxError', async () => {
        const fetchSpy = vi.fn().mockResolvedValue(
            new Response('{"error":"server"}', { status: 500 }),
        );
        vi.stubGlobal('fetch', fetchSpy);

        const client = makeClient();

        await expect(client.createInvoice(SAMPLE_CREATE_REQ)).rejects.toBeInstanceOf(DompetxError);
        expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it('maps the final 5xx failure to code `dompetx_unavailable` with httpStatus 500', async () => {
        const fetchSpy = vi.fn().mockResolvedValue(
            new Response('boom', { status: 503 }),
        );
        vi.stubGlobal('fetch', fetchSpy);

        const client = makeClient();

        let caught: unknown;
        try {
            await client.createInvoice(SAMPLE_CREATE_REQ);
        } catch (e) {
            caught = e;
        }

        expect(caught).toBeInstanceOf(DompetxError);
        const err = caught as DompetxError;
        expect(err.code).toBe('dompetx_unavailable');
        expect(err.httpStatus).toBe(503);
        expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it('never retries on a 4xx response (exactly 1 fetch call)', async () => {
        const fetchSpy = vi.fn().mockResolvedValue(
            new Response('{"error":"bad"}', { status: 400 }),
        );
        vi.stubGlobal('fetch', fetchSpy);

        const client = makeClient();

        await expect(client.createInvoice(SAMPLE_CREATE_REQ)).rejects.toBeInstanceOf(DompetxError);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('never retries on 401 Unauthorized', async () => {
        const fetchSpy = vi.fn().mockResolvedValue(
            new Response('{"error":"unauthorized"}', { status: 401 }),
        );
        vi.stubGlobal('fetch', fetchSpy);

        const client = makeClient();

        let caught: unknown;
        try {
            await client.createInvoice(SAMPLE_CREATE_REQ);
        } catch (e) {
            caught = e;
        }

        expect(caught).toBeInstanceOf(DompetxError);
        expect((caught as DompetxError).code).toBe('dompetx_unauthorized');
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('succeeds without another retry once a 5xx is followed by 2xx', async () => {
        const fetchSpy = vi.fn()
            .mockResolvedValueOnce(new Response('boom', { status: 502 }))
            .mockResolvedValueOnce(
                new Response(JSON.stringify(VALID_INVOICE_RESPONSE), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );
        vi.stubGlobal('fetch', fetchSpy);

        const client = makeClient();
        const result = await client.createInvoice(SAMPLE_CREATE_REQ);

        expect(result.invoice_id).toBe('inv_1');
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
});

// ─── Sensitive key logging (Requirement 15.4) ────────────────────────────────

describe('DompetxClientImpl does not log sensitive values', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let errSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;
    let infoSpy: ReturnType<typeof vi.spyOn>;
    let debugSpy: ReturnType<typeof vi.spyOn>;

    const SENSITIVE_VALUES = [API_KEY, API_SECRET, WEBHOOK_SECRET];

    function collectAllLoggedArgs(): string[] {
        const argBuckets = [
            ...logSpy.mock.calls,
            ...errSpy.mock.calls,
            ...warnSpy.mock.calls,
            ...infoSpy.mock.calls,
            ...debugSpy.mock.calls,
        ];
        const out: string[] = [];
        for (const call of argBuckets) {
            for (const a of call) {
                try {
                    out.push(typeof a === 'string' ? a : JSON.stringify(a));
                } catch {
                    // Unserialisable arg — coerce via String()
                    out.push(String(a));
                }
            }
        }
        return out;
    }

    function assertNoSensitiveLeakage(args: string[]): void {
        for (const arg of args) {
            for (const secret of SENSITIVE_VALUES) {
                expect(arg).not.toContain(secret);
            }
        }
    }

    beforeEach(() => {
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
        debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

        vi.stubGlobal(
            'setTimeout',
            ((fn: () => void) => {
                queueMicrotask(fn);
                return 0 as unknown as ReturnType<typeof setTimeout>;
            }) as unknown as typeof setTimeout,
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('does not log secrets during a successful createInvoice', async () => {
        const fetchSpy = vi.fn().mockResolvedValue(
            new Response(JSON.stringify(VALID_INVOICE_RESPONSE), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        );
        vi.stubGlobal('fetch', fetchSpy);

        const client = makeClient();
        await client.createInvoice(SAMPLE_CREATE_REQ);

        assertNoSensitiveLeakage(collectAllLoggedArgs());
    });

    it('does not log secrets even when createInvoice fails after retries', async () => {
        const fetchSpy = vi.fn().mockResolvedValue(
            new Response('{"error":"server"}', { status: 500 }),
        );
        vi.stubGlobal('fetch', fetchSpy);

        const client = makeClient();
        await expect(client.createInvoice(SAMPLE_CREATE_REQ))
            .rejects.toBeInstanceOf(DompetxError);

        assertNoSensitiveLeakage(collectAllLoggedArgs());
    });

    it('does not log secrets when a network error bubbles up', async () => {
        const fetchSpy = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
        vi.stubGlobal('fetch', fetchSpy);

        const client = makeClient();
        await expect(client.createInvoice(SAMPLE_CREATE_REQ))
            .rejects.toBeInstanceOf(DompetxError);

        assertNoSensitiveLeakage(collectAllLoggedArgs());
    });

    it('does not log secrets during signature verification (both success and failure paths)', async () => {
        const client = makeClient();
        const body = JSON.stringify({ invoice_id: 'inv_x', status: 'paid' });
        const ts = String(Math.floor(Date.now() / 1000));
        const goodSig = await hmacSha256Hex(WEBHOOK_SECRET, `${ts}.${body}`);

        await client.verifyWebhookSignature(body, ts, goodSig);
        await client.verifyWebhookSignature(body, ts, 'deadbeef');
        await client.verifyWebhookSignature('tampered', ts, goodSig);

        assertNoSensitiveLeakage(collectAllLoggedArgs());
    });

    it('DompetxError message from a failed createInvoice never contains secrets', async () => {
        const fetchSpy = vi.fn().mockResolvedValue(
            new Response('server issue', { status: 500 }),
        );
        vi.stubGlobal('fetch', fetchSpy);

        let caught: DompetxError | null = null;
        try {
            await makeClient().createInvoice(SAMPLE_CREATE_REQ);
        } catch (e) {
            caught = e as DompetxError;
        }

        expect(caught).toBeInstanceOf(DompetxError);
        const msg = caught!.message;
        for (const secret of SENSITIVE_VALUES) {
            expect(msg).not.toContain(secret);
        }
    });
});
