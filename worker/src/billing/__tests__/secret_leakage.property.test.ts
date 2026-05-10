import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

vi.mock('worker-mailer', () => ({ default: class {} }));
import workerEntrypoint from '../../worker.js';

function makeCtx() {
    return { waitUntil() {}, passThroughOnException() {} } as ExecutionContext;
}

function makeDbStub(): D1Database {
    const stmt = {
        bind() {
            return this;
        },
        async first<T>() {
            return null as T | null;
        },
        async run() {
            return { success: true, meta: { changes: 0 } };
        },
        async all<T>() {
            return { results: [] as T[] };
        },
    };
    return {
        prepare() {
            return stmt as unknown as D1PreparedStatement;
        },
        batch: async () => [],
        exec: async () => ({ count: 0, duration: 0 }),
    } as unknown as D1Database;
}

function makeEnv(overrides: Partial<Bindings> = {}): Bindings {
    return {
        DB: makeDbStub(),
        KV: {} as KVNamespace,
        RATE_LIMITER: { limit: async () => ({ success: true }) } as unknown as RateLimit,
        SEND_MAIL: {} as SendEmail,
        ASSETS: undefined as unknown as Fetcher,
        AI: {} as Ai,
        JWT_SECRET: 'test-secret',
        DEFAULT_LANG: 'en',
        DOMAINS: ['test.example.com'],
        BILLING_ENABLED: true,
        DOMPETX_API_KEY: 'dompetx-key-default',
        DOMPETX_API_SECRET: 'dompetx-secret-default',
        DOMPETX_WEBHOOK_SECRET: 'dompetx-webhook-default',
        CLOUDFLARE_EMAIL_ROUTING_TOKEN: 'cf-routing-default',
        ...overrides,
    } as unknown as Bindings;
}

const NON_ADMIN_PATHS = [
    '/user_api/wallet',
    '/user_api/wallet/ledger',
    '/user_api/billing/domains',
    '/user_api/topup/history',
    '/open_api/payment_channels',
] as const;

// Feature: saas-topup-billing, Property 36: Secret non-leakage in responses
describe('billing secret non-leakage property', () => {
    it('never leaks billing secrets or raw_payload on non-admin paths', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.record({
                    apiKey: fc.string({ minLength: 6, maxLength: 24 }),
                    apiSecret: fc.string({ minLength: 6, maxLength: 24 }),
                    webhookSecret: fc.string({ minLength: 6, maxLength: 24 }),
                    routingToken: fc.string({ minLength: 6, maxLength: 24 }),
                }),
                async ({ apiKey, apiSecret, webhookSecret, routingToken }) => {
                    const env = makeEnv({
                        DOMPETX_API_KEY: apiKey,
                        DOMPETX_API_SECRET: apiSecret,
                        DOMPETX_WEBHOOK_SECRET: webhookSecret,
                        CLOUDFLARE_EMAIL_ROUTING_TOKEN: routingToken,
                    });
                    const secrets = [apiKey, apiSecret, webhookSecret, routingToken];

                    for (const path of NON_ADMIN_PATHS) {
                        const req = new Request(`https://example.test${path}`);
                        const res = await workerEntrypoint.fetch(req, env, makeCtx());
                        const bodyText = await res.text();
                        for (const secret of secrets) {
                            expect(bodyText).not.toContain(secret);
                        }
                        expect(bodyText).not.toContain('raw_payload');
                    }
                },
            ),
            { numRuns: 40 },
        );
    });
});
