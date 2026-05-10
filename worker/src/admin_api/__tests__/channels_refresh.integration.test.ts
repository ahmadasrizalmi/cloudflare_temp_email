import BetterSqlite3 from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import billingAdminApi from '../billing_admin.js';

function makeDb() {
  const sqlite = new BetterSqlite3(':memory:');
  sqlite.exec(`
    CREATE TABLE payment_channels_cache (
      channel_code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      "group" TEXT,
      min INTEGER NOT NULL,
      max INTEGER,
      fee_type TEXT NOT NULL,
      fee_value INTEGER NOT NULL DEFAULT 0,
      fee_fixed INTEGER NOT NULL DEFAULT 0,
      fee_bearer TEXT NOT NULL DEFAULT 'customer',
      is_active INTEGER NOT NULL DEFAULT 1,
      icon_url TEXT,
      fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE billing_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER,
      event_type TEXT NOT NULL,
      target_user_id INTEGER,
      rule_key TEXT,
      old_value TEXT,
      new_value TEXT,
      reason TEXT,
      metadata TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const db = {
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
        async first<T>() {
          const stmt = sqlite.prepare(this._sql);
          return (stmt.get(...this._params) as T) ?? null;
        },
        async all<T>() {
          const stmt = sqlite.prepare(this._sql);
          const rows = stmt.all(...this._params) as T[];
          return { success: true, meta: { changes: 0 }, results: rows };
        },
      };
    },
    async batch(stmts: any[]) {
      const tx = sqlite.transaction((items: any[]) => {
        const out = [];
        for (const s of items) {
          const stmt = sqlite.prepare(s._sql);
          const reader = stmt.reader;
          if (reader) {
            const rows = stmt.all(...(s._params ?? []));
            out.push({ success: true, meta: { changes: 0 }, results: rows });
          } else {
            const info = stmt.run(...(s._params ?? []));
            out.push({ success: true, meta: { changes: Number(info.changes ?? 0) }, results: [] });
          }
        }
        return out;
      });
      return tx(stmts);
    },
  };

  return { sqlite, db: db as unknown as D1Database };
}

function appWithEnv(env: Bindings) {
  const app = new Hono<HonoCustomType>();
  app.route('/', billingAdminApi);
  return (req: Request) => app.fetch(req, env);
}

describe('admin billing channels refresh integration', () => {
  it('refreshes cache from mocked DompetX channels list and writes audit log', async () => {
    const { sqlite, db } = makeDb();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          channels: [
            {
              channel_code: 'VA_BCA',
              name: 'BCA Virtual Account',
              group: 'va',
              min: 10000,
              max: 1000000,
              fee_type: 'fixed',
              fee_value: 0,
              fee_fixed: 4000,
              fee_bearer: 'customer',
              is_active: true,
              icon_url: 'https://cdn.example/va-bca.png',
            },
            {
              channel_code: 'EW_OVO',
              name: 'OVO',
              group: 'ewallet',
              min: 10000,
              max: null,
              fee_type: 'percentage',
              fee_value: 2,
              fee_fixed: 0,
              fee_bearer: 'merchant',
              is_active: true,
              icon_url: null,
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const env = {
      DB: db,
      DEFAULT_LANG: 'en',
      JWT_SECRET: 'x',
      DOMPETX_API_KEY: 'dk_test',
      DOMPETX_API_SECRET: 'ds_test',
      DOMPETX_WEBHOOK_SECRET: 'whsec_test',
    } as unknown as Bindings;

    const run = appWithEnv(env);
    const res = await run(
      new Request('https://example.test/admin/billing/channels/refresh', {
        method: 'POST',
      }),
    );

    expect(res.status).toBe(200);
    const payload = await res.json() as { count: number; fetched_at: string };
    expect(payload.count).toBe(2);
    expect(typeof payload.fetched_at).toBe('string');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const cacheCount = sqlite.prepare('SELECT COUNT(1) AS c FROM payment_channels_cache').get() as { c: number };
    expect(cacheCount.c).toBe(2);

    const row = sqlite.prepare(
      'SELECT channel_code, fee_type, fee_bearer, is_active FROM payment_channels_cache WHERE channel_code = ?',
    ).get('VA_BCA') as {
      channel_code: string;
      fee_type: string;
      fee_bearer: string;
      is_active: number;
    };
    expect(row.channel_code).toBe('VA_BCA');
    expect(row.fee_type).toBe('fixed');
    expect(row.fee_bearer).toBe('customer');
    expect(row.is_active).toBe(1);

    const audit = sqlite.prepare(
      "SELECT event_type, metadata FROM billing_audit_logs WHERE event_type = 'channel_refresh' ORDER BY id DESC LIMIT 1",
    ).get() as { event_type: string; metadata: string };
    expect(audit.event_type).toBe('channel_refresh');
    expect(audit.metadata).toContain('"count":2');

    fetchMock.mockRestore();
    sqlite.close();
  });
});
