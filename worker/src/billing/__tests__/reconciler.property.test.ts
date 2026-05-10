import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { runReconcile } from '../reconciler.js';

type FakePendingRow = {
    id: number;
    user_id: number;
    invoice_id: string;
    amount: number;
    expiry_minutes: number;
};

class FakeStmt {
    private params: unknown[] = [];
    constructor(private readonly db: FakeDb, private readonly sql: string) {}
    bind(...params: unknown[]) {
        this.params = params;
        return this;
    }
    async all<T>() {
        return this.db.execAll<T>(this.sql, this.params);
    }
    async first<T>() {
        return this.db.execFirst<T>(this.sql, this.params);
    }
    async run() {
        return this.db.execRun(this.sql, this.params);
    }
}

class FakeDb {
    public readonly statuses = new Map<string, string>();
    public updatedWeight: number | null = null;
    public auditRows = 0;
    constructor(
        private readonly pendingRows: FakePendingRow[],
        private readonly totalTopup: number,
        private readonly totalDebitIdr: number,
    ) {
        for (const row of pendingRows) this.statuses.set(row.invoice_id, 'pending');
    }
    prepare(sql: string) {
        return new FakeStmt(this, sql);
    }
    async batch(stmts: FakeStmt[]) {
        const out: Array<{ meta?: { changes?: number }; results?: Array<Record<string, unknown>> }> = [];
        for (const stmt of stmts) {
            out.push(await stmt.run());
        }
        return out;
    }
    async execAll<T>(sql: string, params: unknown[]) {
        if (sql.includes('FROM topup_transactions') && sql.includes("status = 'pending'")) {
            const limit = Number(params[0] ?? 100);
            const rows = this.pendingRows
                .filter((r) => this.statuses.get(r.invoice_id) === 'pending')
                .slice(0, limit) as T[];
            return { results: rows };
        }
        return { results: [] as T[] };
    }
    async execFirst<T>(sql: string, _params: unknown[]) {
        if (sql.includes('total_topup')) {
            return { total_topup: this.totalTopup } as T;
        }
        if (sql.includes('total_debit_idr')) {
            return { total_debit_idr: this.totalDebitIdr } as T;
        }
        return null as T;
    }
    async execRun(sql: string, params: unknown[]) {
        if (sql.includes('UPDATE topup_transactions')) {
            const isPaid = sql.includes("SET status = 'paid'");
            const newStatus = isPaid ? 'paid' : String(params[0]);
            const invoiceId = isPaid ? String(params[1]) : String(params[1]);
            const cur = this.statuses.get(invoiceId);
            const changes = cur === 'pending' ? 1 : 0;
            if (changes === 1) this.statuses.set(invoiceId, newStatus);
            return { meta: { changes }, results: [] };
        }
        if (sql.includes('INSERT INTO pricing_rules') && params.length > 0) {
            try {
                this.updatedWeight = JSON.parse(String(params[0]));
            } catch {
                this.updatedWeight = Number(params[0]);
            }
            return { meta: { changes: 1 }, results: [] };
        }
        if (sql.includes('INSERT INTO billing_audit_logs')) {
            this.auditRows += 1;
            return { meta: { changes: 1 }, results: [] };
        }
        return { meta: { changes: 1 }, results: [] };
    }
}

// Feature: saas-topup-billing, Property 24: Reconciler expires pending and honors late paid
describe('reconciler Property 24', () => {
    it('calls provider once per row and converges statuses by provider result', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.array(fc.constantFrom('paid', 'failed', 'expired', 'pending'), { minLength: 1, maxLength: 25 }),
                async (providerStatuses) => {
                    const rows: FakePendingRow[] = providerStatuses.map((_, i) => ({
                        id: i + 1,
                        user_id: 100 + i,
                        invoice_id: `inv-${i + 1}`,
                        amount: 10000 + i * 500,
                        expiry_minutes: 30,
                    }));
                    const db = new FakeDb(rows, 100000, 20000);
                    const calls: string[] = [];
                    const walletCredits: string[] = [];
                    const dompetx = {
                        async getInvoiceStatus(invoiceId: string) {
                            calls.push(invoiceId);
                            const idx = Number(invoiceId.split('-')[1]) - 1;
                            const status = providerStatuses[idx] ?? 'pending';
                            return { invoice_id: invoiceId, status, paid_at: null };
                        },
                    };
                    const wallet = {
                        async creditTopup(args: { invoiceId: string }) {
                            walletCredits.push(args.invoiceId);
                            return { topupLedgerId: 1, newBalance: 10 };
                        },
                    };
                    const pricing = {
                        async getNumber(key: string) {
                            if (key === 'credit_idr_rate') return 100;
                            if (key === 'bonus_threshold_idr') return 100000;
                            if (key === 'bonus_rate_percent') return 5;
                            if (key === 'margin_guard_target_percent') return 55;
                            if (key === 'domain_weight_com') return 4;
                            return 1;
                        },
                        async getObject() {
                            return false;
                        },
                        invalidateCache() {},
                    };

                    const summary = await runReconcile(
                        { DB: db as unknown as D1Database } as Bindings,
                        undefined,
                        {
                            dompetx: dompetx as unknown as any,
                            wallet: wallet as unknown as any,
                            pricing: pricing as unknown as any,
                            batchSize: 100,
                        },
                    );

                    expect(calls.length).toBe(rows.length);
                    expect(new Set(calls).size).toBe(rows.length);
                    expect(summary.processed).toBe(rows.length);

                    const paidCount = providerStatuses.filter((s) => s === 'paid').length;
                    const failedCount = providerStatuses.filter((s) => s === 'failed').length;
                    const expiredCount = providerStatuses.filter((s) => s === 'expired').length;
                    expect(summary.paid).toBe(paidCount);
                    expect(summary.failed).toBe(failedCount);
                    expect(summary.expired).toBe(expiredCount);
                    expect(walletCredits.length).toBe(paidCount);

                    rows.forEach((row, idx) => {
                        const provider = providerStatuses[idx];
                        const final = db.statuses.get(row.invoice_id);
                        if (provider === 'paid' || provider === 'failed' || provider === 'expired') {
                            expect(final).toBe(provider);
                        } else {
                            expect(final).toBe('pending');
                        }
                    });
                },
            ),
            { numRuns: 100 },
        );
    });
});

// Feature: saas-topup-billing, Property 32: Auto margin guard upper bound
describe('reconciler Property 32', () => {
    it('increments domain_weight_com by at most 1 and never above 5', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.record({
                    auto: fc.boolean(),
                    target: fc.integer({ min: 1, max: 95 }),
                    current: fc.integer({ min: 1, max: 5 }),
                    net: fc.integer({ min: -50, max: 100 }),
                }),
                async ({ auto, target, current, net }) => {
                    const rows: FakePendingRow[] = [{
                        id: 1,
                        user_id: 1,
                        invoice_id: 'inv-1',
                        amount: 10000,
                        expiry_minutes: 30,
                    }];
                    const totalTopup = 100000;
                    const totalDebitIdr = Math.max(0, Math.floor(totalTopup * (1 - net / 100)));
                    const db = new FakeDb(rows, totalTopup, totalDebitIdr);
                    const invalidateSpy = { count: 0 };
                    const pricing = {
                        async getNumber(key: string) {
                            if (key === 'credit_idr_rate') return 100;
                            if (key === 'bonus_threshold_idr') return 100000;
                            if (key === 'bonus_rate_percent') return 5;
                            if (key === 'margin_guard_target_percent') return target;
                            if (key === 'domain_weight_com') return current;
                            return 1;
                        },
                        async getObject(key: string) {
                            if (key === 'margin_guard_auto') return auto;
                            return false;
                        },
                        invalidateCache() {
                            invalidateSpy.count += 1;
                        },
                    };
                    const dompetx = {
                        async getInvoiceStatus() {
                            return { invoice_id: 'inv-1', status: 'pending', paid_at: null };
                        },
                    };
                    const wallet = {
                        async creditTopup() {
                            return { topupLedgerId: 1, newBalance: 1 };
                        },
                    };

                    const summary = await runReconcile(
                        { DB: db as unknown as D1Database } as Bindings,
                        undefined,
                        {
                            dompetx: dompetx as unknown as any,
                            wallet: wallet as unknown as any,
                            pricing: pricing as unknown as any,
                            batchSize: 10,
                        },
                    );

                    const expectedAdjust = auto && net < target && current < 5;
                    expect(Boolean(summary.marginAdjusted)).toBe(expectedAdjust);
                    if (expectedAdjust) {
                        expect(db.updatedWeight).toBe(current + 1);
                        expect(db.updatedWeight).toBeLessThanOrEqual(5);
                        expect(db.auditRows).toBe(1);
                        expect(invalidateSpy.count).toBe(1);
                    } else {
                        expect(db.updatedWeight).toBeNull();
                    }
                },
            ),
            { numRuns: 100 },
        );
    });
});
