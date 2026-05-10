import BetterSqlite3 from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import billingAdminApi from '../billing_admin.js';

function makeDb() {
    const sqlite = new BetterSqlite3(':memory:');
    sqlite.exec(`
      CREATE TABLE allowed_domains (
        domain TEXT PRIMARY KEY,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_by INTEGER
      );
      CREATE TABLE pricing_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_key TEXT NOT NULL,
        rule_value_json TEXT NOT NULL,
        version INTEGER NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(rule_key, version)
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
    return {
        sqlite,
        db: {
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
                        return { success: true, meta: { changes: info.changes }, results: [] };
                    },
                    async first<T>() {
                        const stmt = sqlite.prepare(this._sql);
                        return (stmt.get(...this._params) as T) ?? null;
                    },
                    async all<T>() {
                        const stmt = sqlite.prepare(this._sql);
                        const rows = stmt.all(...this._params) as T[];
                        return { success: true, results: rows, meta: { changes: 0 } };
                    },
                };
            },
            async batch(stmts: any[]) {
                const out = [];
                for (const s of stmts) out.push(await s.run());
                return out;
            },
        } as unknown as D1Database,
    };
}

function appWithEnv(env: Bindings) {
    const app = new Hono<HonoCustomType>();
    app.route('/', billingAdminApi);
    return (req: Request) => app.fetch(req, env);
}

describe('admin billing domains integration', () => {
    it('inserts domain only when mocked Cloudflare API succeeds', async () => {
        const { sqlite, db } = makeDb();
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ success: true }), { status: 200 }),
        );

        const env = {
            DB: db,
            JWT_SECRET: 'x',
            DEFAULT_LANG: 'en',
            CLOUDFLARE_EMAIL_ROUTING_TOKEN: 'token',
            CLOUDFLARE_ACCOUNT_ID: 'acc',
            CLOUDFLARE_ZONE_ID: 'zone',
        } as unknown as Bindings;

        const run = appWithEnv(env);
        const res = await run(
            new Request('https://example.test/admin/billing/domains', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ domain: 'billing.example.com' }),
            }),
        );
        expect(res.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const row = sqlite.prepare('SELECT domain FROM allowed_domains WHERE domain = ?').get('billing.example.com');
        expect(row).toBeTruthy();
        fetchMock.mockRestore();
        sqlite.close();
    });

    it('returns 400 and does not insert when mocked Cloudflare API fails', async () => {
        const { sqlite, db } = makeDb();
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ success: false }), { status: 500 }),
        );

        const env = {
            DB: db,
            JWT_SECRET: 'x',
            DEFAULT_LANG: 'en',
            CLOUDFLARE_EMAIL_ROUTING_TOKEN: 'token',
            CLOUDFLARE_ACCOUNT_ID: 'acc',
            CLOUDFLARE_ZONE_ID: 'zone',
        } as unknown as Bindings;

        const run = appWithEnv(env);
        const res = await run(
            new Request('https://example.test/admin/billing/domains', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ domain: 'blocked.example.com' }),
            }),
        );
        expect(res.status).toBe(400);
        const row = sqlite.prepare('SELECT domain FROM allowed_domains WHERE domain = ?').get('blocked.example.com');
        expect(row).toBeFalsy();
        fetchMock.mockRestore();
        sqlite.close();
    });
});

