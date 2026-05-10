// Feature: saas-topup-billing, Property 11 and 14 for user Billing_API
import fc from 'fast-check';
import BetterSqlite3 from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';

import { createBillingApi } from '../billing.js';
import { createPricingEngine } from '../../billing/pricing_engine.js';

function makeD1(sqlite: BetterSqlite3.Database): D1Database {
  return {
    prepare(sql: string) {
      return {
        _sql: sql,
        _params: [] as unknown[],
        bind(...p: unknown[]) {
          this._params = p;
          return this;
        },
        async run() {
          const stmt = sqlite.prepare(this._sql);
          const info = stmt.run(...this._params);
          return { success: true, meta: { changes: Number(info.changes ?? 0) }, results: [] };
        },
        async first<T>(column?: string) {
          const stmt = sqlite.prepare(this._sql);
          const row = (stmt.get(...this._params) as Record<string, unknown> | undefined) ?? undefined;
          if (!row) return null;
          if (column) return (row[column] ?? null) as T | null;
          return row as unknown as T;
        },
        async all<T>() {
          const stmt = sqlite.prepare(this._sql);
          const rows = stmt.all(...this._params) as T[];
          return { success: true, meta: { changes: 0 }, results: rows };
        },
      } as unknown as D1PreparedStatement;
    },
    async batch(stmts: D1PreparedStatement[]) {
      const tx = sqlite.transaction((items: D1PreparedStatement[]) => {
        const out = [] as unknown[];
        for (const s of items as unknown as Array<{ _sql: string; _params: unknown[] }>) {
          const stmt = sqlite.prepare(s._sql);
          if (stmt.reader) {
            const rows = stmt.all(...s._params);
            out.push({ success: true, meta: { changes: 0 }, results: rows });
          } else {
            const info = stmt.run(...s._params);
            out.push({ success: true, meta: { changes: Number(info.changes ?? 0) }, results: [] });
          }
        }
        return out;
      });
      return tx(stmts);
    },
  } as unknown as D1Database;
}

function makeAuthedApp(env: Bindings, deps?: Parameters<typeof createBillingApi>[0]) {
  const app = new Hono<HonoCustomType>();
  app.use('/user_api/*', async (c, next) => {
    c.set('userPayload', { user_id: 1 } as UserPayload);
    await next();
  });
  app.route('/', createBillingApi(deps));
  return (req: Request) => app.fetch(req, env);
}

describe('user Billing_API properties', () => {
  it('Property 11: domain preview matches Pricing_Engine', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          weightCom: fc.integer({ min: 1, max: 5 }),
          weightDefault: fc.integer({ min: 1, max: 5 }),
          costCreate: fc.integer({ min: 1, max: 10 }),
          activeCom: fc.boolean(),
          activeMyId: fc.boolean(),
          activeWebId: fc.boolean(),
        }),
        async ({ weightCom, weightDefault, costCreate, activeCom, activeMyId, activeWebId }) => {
          const sqlite = new BetterSqlite3(':memory:');
          sqlite.exec(`
            CREATE TABLE pricing_rules (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              rule_key TEXT NOT NULL,
              rule_value_json TEXT NOT NULL,
              version INTEGER NOT NULL,
              is_active INTEGER NOT NULL DEFAULT 1,
              created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE allowed_domains (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              domain TEXT NOT NULL UNIQUE,
              is_active INTEGER NOT NULL DEFAULT 1,
              created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
              created_by INTEGER
            );
          `);

          const insertRule = sqlite.prepare(
            `INSERT INTO pricing_rules (rule_key, rule_value_json, version, is_active) VALUES (?, ?, 1, 1)`,
          );
          insertRule.run('domain_weight_com', JSON.stringify(weightCom));
          insertRule.run('domain_weight_default', JSON.stringify(weightDefault));
          insertRule.run('action_cost_create_address', JSON.stringify(costCreate));

          const insertDomain = sqlite.prepare(
            `INSERT INTO allowed_domains (domain, is_active) VALUES (?, ?)`,
          );
          insertDomain.run('alpha.com', activeCom ? 1 : 0);
          insertDomain.run('beta.my.id', activeMyId ? 1 : 0);
          insertDomain.run('gamma.web.id', activeWebId ? 1 : 0);

          const db = makeD1(sqlite);
          createPricingEngine(db).invalidateCache();
          const env = { DB: db, DEFAULT_LANG: 'en' } as unknown as Bindings;
          const run = makeAuthedApp(env);

          const res = await run(new Request('https://example.test/user_api/billing/domains'));
          expect(res.status).toBe(200);
          const body = await res.json() as Array<{ domain: string; credit_cost: number }>;

          const engine = createPricingEngine(db);
          engine.invalidateCache();

          const activeDomains = ['alpha.com', 'beta.my.id', 'gamma.web.id'].filter((d) => {
            if (d === 'alpha.com') return activeCom;
            if (d === 'beta.my.id') return activeMyId;
            return activeWebId;
          });

          expect(body.length).toBe(activeDomains.length);
          for (const entry of body) {
            expect(activeDomains.includes(entry.domain)).toBe(true);
            const expected = await engine.resolve({ actionKey: 'create_address', domain: entry.domain });
            expect(entry.credit_cost).toBe(expected);
          }

          sqlite.close();
        },
      ),
      { numRuns: 60 },
    );
  });

  it('Property 14: minimum top-up guard short-circuits DompetX', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          minTopup: fc.integer({ min: 1000, max: 200000 }),
          delta: fc.integer({ min: 1, max: 999 }),
        }),
        async ({ minTopup, delta }) => {
          const below = minTopup - delta;

          const sqlite = new BetterSqlite3(':memory:');
          sqlite.exec(`
            CREATE TABLE topup_transactions (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id INTEGER NOT NULL,
              invoice_id TEXT UNIQUE,
              provider_reference TEXT UNIQUE,
              channel_code TEXT,
              amount INTEGER,
              fee INTEGER,
              gross_amount INTEGER,
              fee_bearer TEXT,
              status TEXT,
              fingerprint_hash TEXT,
              ip TEXT,
              expiry_minutes INTEGER,
              checkout_url TEXT,
              created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
          `);

          let dompetxCreateCalls = 0;
          let channelQuoteCalls = 0;

          const deps = {
            pricingEngine: () => ({
              resolve: async () => 1,
              getNumber: async (k: string) => {
                if (k === 'min_topup_idr') return minTopup;
                if (k === 'bonus_threshold_idr') return minTopup * 10;
                return 1;
              },
              getObject: async () => ({}),
              invalidateCache: () => {},
              listDomainCosts: async () => [],
            }),
            abuseGuard: {
              requireFingerprint: async (c: any) => {
                c.set('fingerprint_hash', 'fp_hash');
                return 'fp_hash';
              },
              checkTopupQuote: async () => {},
              checkTopupCreate: async () => {},
            },
            channelCache: () => ({
              listPublic: async () => [],
              listForQuote: async (nominal: number) => {
                channelQuoteCalls += 1;
                return [{
                  channel_code: 'VA_BCA',
                  name: 'BCA',
                  group: 'va',
                  min: minTopup,
                  max: null,
                  fee_type: 'fixed',
                  fee_value: 0,
                  fee_fixed: 1000,
                  fee_bearer: 'customer',
                  is_active: true,
                  estimated_fee: 1000,
                  gross_amount: nominal + 1000,
                  icon_url: undefined,
                }];
              },
              refresh: async () => ({ count: 1 }),
            }),
            dompetxClient: () => ({
              createInvoice: async () => {
                dompetxCreateCalls += 1;
                return {
                  invoice_id: `inv_${crypto.randomUUID()}`,
                  checkout_url: 'https://pay.example/checkout',
                  provider_reference: 'pref',
                  amount: minTopup,
                  fee: 1000,
                  gross_amount: minTopup + 1000,
                  status: 'pending',
                  expiry_minutes: 30,
                };
              },
              getInvoiceStatus: async () => ({
                invoice_id: 'x',
                provider_reference: null,
                status: 'pending',
                amount: 0,
                fee: 0,
                gross_amount: 0,
                paid_at: null,
                channel_code: 'VA_BCA',
              }),
              listChannels: async () => [],
              verifyWebhookSignature: async () => true,
              isTimestampWithinWindow: () => true,
            }),
          };

          const db = makeD1(sqlite);
          const env = { DB: db, DEFAULT_LANG: 'en' } as unknown as Bindings;
          const run = makeAuthedApp(env, deps as any);

          const quoteBelowRes = await run(new Request('https://example.test/user_api/topup/quote', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-fingerprint': 'fp' },
            body: JSON.stringify({ nominal: below }),
          }));
          expect(quoteBelowRes.status).toBe(400);

          const createBelowRes = await run(new Request('https://example.test/user_api/topup/create', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-fingerprint': 'fp' },
            body: JSON.stringify({ nominal: below, channel_code: 'VA_BCA' }),
          }));
          expect(createBelowRes.status).toBe(400);

          expect(dompetxCreateCalls).toBe(0);
          expect(channelQuoteCalls).toBe(0);

          const quoteBoundaryRes = await run(new Request('https://example.test/user_api/topup/quote', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-fingerprint': 'fp' },
            body: JSON.stringify({ nominal: minTopup }),
          }));
          expect(quoteBoundaryRes.status).toBe(200);

          const createBoundaryRes = await run(new Request('https://example.test/user_api/topup/create', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-fingerprint': 'fp' },
            body: JSON.stringify({ nominal: minTopup, channel_code: 'VA_BCA' }),
          }));
          expect(createBoundaryRes.status).toBe(200);
          expect(dompetxCreateCalls).toBe(1);

          sqlite.close();
        },
      ),
      { numRuns: 40 },
    );
  });
});
