import { describe, expect, it, vi } from 'vitest';

vi.mock('../../billing/reconciler', () => {
    return {
        runReconcile: vi.fn(async () => ({ processed: 0, paid: 0, failed: 0, expired: 0 })),
    };
});

import { scheduled } from '../../scheduled.js';
import { runReconcile } from '../../billing/reconciler.js';

describe('scheduled -> reconciler integration', () => {
    it('invokes runReconcile once per scheduled event', async () => {
        const env = {
            DB: {} as D1Database,
            KV: { get: vi.fn(async () => null) } as unknown as KVNamespace,
        } as unknown as Bindings;
        const ctx = { waitUntil: vi.fn() };
        await scheduled({ cron: '*/5 * * * *' } as ScheduledEvent, env, ctx);
        expect(runReconcile).toHaveBeenCalledTimes(1);
    });
});

