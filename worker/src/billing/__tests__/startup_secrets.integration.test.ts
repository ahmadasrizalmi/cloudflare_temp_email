import { describe, expect, it, vi } from 'vitest';
vi.mock('worker-mailer', () => ({ default: class {} }));
import workerEntrypoint from '../../worker.js';

function makeCtx() {
    return { waitUntil() {}, passThroughOnException() {} } as ExecutionContext;
}

function makeEnv(overrides: Partial<Bindings> = {}): Bindings {
    return {
        DB: {} as D1Database,
        KV: {} as KVNamespace,
        RATE_LIMITER: { limit: async () => ({ success: true }) } as unknown as RateLimit,
        SEND_MAIL: {} as SendEmail,
        ASSETS: undefined as unknown as Fetcher,
        AI: {} as Ai,
        JWT_SECRET: 'test-secret',
        DEFAULT_LANG: 'en',
        DOMAINS: ['test.example.com'],
        BILLING_ENABLED: true,
        DOMPETX_API_KEY: undefined,
        DOMPETX_API_SECRET: undefined,
        DOMPETX_WEBHOOK_SECRET: undefined,
        CLOUDFLARE_EMAIL_ROUTING_TOKEN: undefined,
        ...overrides,
    } as unknown as Bindings;
}

describe('startup billing secret validation integration', () => {
    it('returns explicit error for billing route when BILLING_ENABLED=true and secrets missing', async () => {
        const req = new Request('https://example.test/user_api/wallet', {
            headers: { 'x-user-token': 'dummy' },
        });
        const res = await workerEntrypoint.fetch(req, makeEnv(), makeCtx());
        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body.code).toBe('billing_misconfigured');
        expect(String(body.message)).toContain('DOMPETX_API_KEY');
    });

    it('non-billing route remains functional under missing billing secrets', async () => {
        const req = new Request('https://example.test/open_api/settings');
        const res = await workerEntrypoint.fetch(req, makeEnv(), makeCtx());
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toBeTruthy();
    });
});
