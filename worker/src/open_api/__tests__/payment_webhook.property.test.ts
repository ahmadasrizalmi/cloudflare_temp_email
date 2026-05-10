// Feature: saas-topup-billing, Property 18-22: Payment_Webhook correctness
import fc from 'fast-check';
import BetterSqlite3, { type Database as BetterSqlite3Database } from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';

import { api as paymentWebhookApi } from '../payment_webhook.js';
import { createWalletService } from '../../billing/wallet_service.js';
import { createPricingEngine } from '../../billing/pricing_engine.js';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  user_email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wallets (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  balance_credit INTEGER NOT NULL DEFAULT 0 CHECK (balance_credit >= 0),
  balance_idr_ref INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('TOPUP','DEBIT','ADJUST','BONUS','REFUND')),
  credit_delta INTEGER NOT NULL CHECK (
    (type = 'DEBIT' AND credit_delta < 0) OR
    (type IN ('TOPUP','BONUS','REFUND') AND credit_delta > 0) OR
    (type = 'ADJUST' AND credit_delta != 0)
  ),
  idr_ref INTEGER,
  metadata TEXT,
  idempotency_key TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_idem_type
  ON credit_ledger(idempotency_key, type)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS pricing_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_key TEXT NOT NULL,
  rule_value_json TEXT NOT NULL,
  version INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(rule_key, version)
);

CREATE TABLE IF NOT EXISTS topup_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  invoice_id TEXT UNIQUE,
  provider_reference TEXT UNIQUE,
  channel_code TEXT NOT NULL DEFAULT 'VA_BCA',
  amount INTEGER NOT NULL,
  fee INTEGER NOT NULL DEFAULT 0,
  gross_amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  checkout_url TEXT,
  fingerprint_hash TEXT,
  ip TEXT,
  expiry_minutes INTEGER NOT NULL DEFAULT 30,
  raw_payload TEXT,
  paid_at DATETIME,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS billing_audit_logs (
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
`;

interface FakeD1Result<T = Record<string, unknown>> {
  success: true;
  results: T[];
  meta: { changes: number; rows_written: number; duration: number };
}

interface FakePreparedStatement {
  bind(...values: unknown[]): FakePreparedStatement;
  run<T = Record<string, unknown>>(): Promise<FakeD1Result<T>>;
  first<T = unknown>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<FakeD1Result<T>>;
  readonly __sql: string;
  readonly __params: unknown[];
}

interface FakeD1Database {
  prepare(sql: string): FakePreparedStatement;
  batch<T = Record<string, unknown>>(stmts: FakePreparedStatement[]): Promise<FakeD1Result<T>[]>;
}

function runStatementOnce(
  sqlite: BetterSqlite3Database,
  sql: string,
  params: unknown[],
): { rows: Record<string, unknown>[]; changes: number } {
  const stmt = sqlite.prepare(sql);
  if (stmt.reader) {
    const rows = (params.length > 0 ? stmt.all(...params) : stmt.all()) as Record<string, unknown>[];
    const changes = sqlite.prepare('SELECT changes() AS c').pluck().get() as number;
    return { rows, changes: typeof changes === 'number' ? changes : 0 };
  }
  const info = params.length > 0 ? stmt.run(...params) : stmt.run();
  return { rows: [], changes: Number(info.changes ?? 0) };
}

function wrapResult<T>(rows: Record<string, unknown>[], changes: number): FakeD1Result<T> {
  return {
    success: true,
    results: rows as unknown as T[],
    meta: { changes, rows_written: changes, duration: 0 },
  };
}

function makePreparedStatement(
  sqlite: BetterSqlite3Database,
  sql: string,
  boundParams: unknown[] = [],
): FakePreparedStatement {
  return {
    __sql: sql,
    __params: boundParams,
    bind(...values: unknown[]): FakePreparedStatement {
      return makePreparedStatement(sqlite, sql, [...boundParams, ...values]);
    },
    async run<T = Record<string, unknown>>(): Promise<FakeD1Result<T>> {
      const { rows, changes } = runStatementOnce(sqlite, sql, boundParams);
      return wrapResult<T>(rows, changes);
    },
    async first<T = unknown>(column?: string): Promise<T | null> {
      const stmt = sqlite.prepare(sql);
      const row = (boundParams.length > 0 ? stmt.get(...boundParams) : stmt.get()) as Record<string, unknown> | undefined;
      if (!row) return null;
      if (typeof column === 'string') return (row[column] ?? null) as T | null;
      return row as unknown as T;
    },
    async all<T = Record<string, unknown>>(): Promise<FakeD1Result<T>> {
      const { rows, changes } = runStatementOnce(sqlite, sql, boundParams);
      return wrapResult<T>(rows, changes);
    },
  };
}

function makeFakeD1(sqlite: BetterSqlite3Database): FakeD1Database {
  return {
    prepare(sql: string): FakePreparedStatement {
      return makePreparedStatement(sqlite, sql);
    },
    async batch<T = Record<string, unknown>>(stmts: FakePreparedStatement[]): Promise<FakeD1Result<T>[]> {
      const exec = sqlite.transaction((list: FakePreparedStatement[]) => {
        const out: FakeD1Result<T>[] = [];
        for (const s of list) {
          const { rows, changes } = runStatementOnce(sqlite, s.__sql, s.__params);
          out.push(wrapResult<T>(rows, changes));
        }
        return out;
      });
      return exec(stmts);
    },
  };
}

function seedPricingRules(sqlite: BetterSqlite3Database, overrides?: {
  creditIdrRate?: number;
  bonusThresholdIdr?: number;
  bonusRatePercent?: number;
}) {
  const creditIdrRate = overrides?.creditIdrRate ?? 100;
  const bonusThresholdIdr = overrides?.bonusThresholdIdr ?? 100000;
  const bonusRatePercent = overrides?.bonusRatePercent ?? 5;
  const insert = sqlite.prepare(
    `INSERT INTO pricing_rules (rule_key, rule_value_json, version, is_active)
     VALUES (?, ?, 1, 1)`,
  );
  insert.run('credit_idr_rate', JSON.stringify(creditIdrRate));
  insert.run('bonus_threshold_idr', JSON.stringify(bonusThresholdIdr));
  insert.run('bonus_rate_percent', JSON.stringify(bonusRatePercent));
}

function seedPendingTopup(
  sqlite: BetterSqlite3Database,
  args: { userId: number; invoiceId: string; amount: number; status?: string },
) {
  sqlite.prepare(`INSERT INTO users (id, user_email, password) VALUES (?, ?, ?)`).run(
    args.userId,
    `user${args.userId}@example.test`,
    'hashed',
  );
  sqlite.prepare(
    `INSERT INTO wallets (user_id, balance_credit, balance_idr_ref) VALUES (?, 0, 0)`,
  ).run(args.userId);
  sqlite.prepare(
    `INSERT INTO topup_transactions
      (user_id, invoice_id, amount, fee, gross_amount, status, channel_code)
     VALUES (?, ?, ?, 0, ?, ?, 'VA_BCA')`,
  ).run(args.userId, args.invoiceId, args.amount, args.amount, args.status ?? 'pending');
}

async function signWebhook(secret: string, timestamp: string, rawBody: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${rawBody}`));
  return Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function postWebhook(env: Bindings, body: unknown, timestamp: string, signature: string): Promise<Response> {
  const app = new Hono<HonoCustomType>();
  app.route('/', paymentWebhookApi);
  return app.fetch(
    new Request('https://example.test/open_api/payment/webhook/dompetx', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dompetx-timestamp': timestamp,
        'x-dompetx-signature': signature,
      },
      body: JSON.stringify(body),
    }),
    env,
  );
}

function makeEnv(db: D1Database, webhookSecret = 'whsec_test'): Bindings {
  return {
    DB: db,
    DEFAULT_LANG: 'en',
    DOMPETX_API_KEY: 'dk_test',
    DOMPETX_API_SECRET: 'ds_test',
    DOMPETX_WEBHOOK_SECRET: webhookSecret,
  } as unknown as Bindings;
}

function invalidatePricingCache(db: D1Database) {
  createPricingEngine(db).invalidateCache();
}

function countLedgerByInvoice(sqlite: BetterSqlite3Database, invoiceId: string, type: string): number {
  const row = sqlite.prepare(
    `SELECT COUNT(1) AS c FROM credit_ledger WHERE idempotency_key = ? AND type = ?`,
  ).get(invoiceId, type) as { c: number };
  return row.c;
}

function getWalletBalance(sqlite: BetterSqlite3Database, userId: number): number {
  const row = sqlite.prepare(`SELECT balance_credit FROM wallets WHERE user_id = ?`).get(userId) as { balance_credit: number };
  return row.balance_credit;
}

describe('Payment_Webhook properties', () => {
  it('Property 18: signature verification (valid accepted, tampered rejected with zero mutation)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          userId: fc.integer({ min: 1, max: 1000 }),
          amount: fc.integer({ min: 10000, max: 500000 }),
          invoiceSeed: fc.integer({ min: 1, max: 10_000_000 }),
        }),
        async ({ userId, amount, invoiceSeed }) => {
          const nowTs = String(Math.floor(Date.now() / 1000));
          const invoiceId = `inv_${invoiceSeed}`;
          const payload = { invoice_id: invoiceId, status: 'paid', paid_at: new Date().toISOString() };

          {
            const sqlite = new BetterSqlite3(':memory:');
            sqlite.exec(SCHEMA_SQL);
            seedPricingRules(sqlite);
            seedPendingTopup(sqlite, { userId, invoiceId, amount });
            const env = makeEnv(makeFakeD1(sqlite) as unknown as D1Database);
            invalidatePricingCache(env.DB);
            const raw = JSON.stringify(payload);
            const signature = await signWebhook(env.DOMPETX_WEBHOOK_SECRET, nowTs, raw);
            const res = await postWebhook(env, payload, nowTs, signature);
            expect(res.status).not.toBe(401);
            sqlite.close();
          }

          {
            const sqlite = new BetterSqlite3(':memory:');
            sqlite.exec(SCHEMA_SQL);
            seedPricingRules(sqlite);
            seedPendingTopup(sqlite, { userId, invoiceId, amount });
            const env = makeEnv(makeFakeD1(sqlite) as unknown as D1Database);
            invalidatePricingCache(env.DB);
            const raw = JSON.stringify(payload);
            const signature = await signWebhook(env.DOMPETX_WEBHOOK_SECRET, nowTs, raw);
            const tamperedPayload = { ...payload, status: 'failed' };
            const beforeTopup = sqlite.prepare(
              `SELECT status, raw_payload FROM topup_transactions WHERE invoice_id = ?`,
            ).get(invoiceId) as { status: string; raw_payload: string | null };
            const beforeLedgerCount = sqlite.prepare(`SELECT COUNT(1) AS c FROM credit_ledger`).get() as { c: number };
            const beforeBalance = getWalletBalance(sqlite, userId);

            const res = await postWebhook(env, tamperedPayload, nowTs, signature);
            expect(res.status).toBe(401);

            const afterTopup = sqlite.prepare(
              `SELECT status, raw_payload FROM topup_transactions WHERE invoice_id = ?`,
            ).get(invoiceId) as { status: string; raw_payload: string | null };
            const afterLedgerCount = sqlite.prepare(`SELECT COUNT(1) AS c FROM credit_ledger`).get() as { c: number };
            const afterBalance = getWalletBalance(sqlite, userId);
            expect(afterTopup.status).toBe(beforeTopup.status);
            expect(afterTopup.raw_payload).toBe(beforeTopup.raw_payload);
            expect(afterLedgerCount.c).toBe(beforeLedgerCount.c);
            expect(afterBalance).toBe(beforeBalance);
            sqlite.close();
          }
        },
      ),
      { numRuns: 40 },
    );
  });

  it('Property 19: paid transition credits wallet exactly once', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          userId: fc.integer({ min: 1, max: 1000 }),
          amount: fc.integer({ min: 1000, max: 2_000_000 }),
          creditIdrRate: fc.integer({ min: 1, max: 1000 }),
          bonusThresholdIdr: fc.integer({ min: 1000, max: 300_000 }),
          bonusRatePercent: fc.integer({ min: 0, max: 30 }),
          invoiceSeed: fc.integer({ min: 1, max: 10_000_000 }),
        }).filter((x) => x.amount >= x.creditIdrRate),
        async ({ userId, amount, creditIdrRate, bonusThresholdIdr, bonusRatePercent, invoiceSeed }) => {
          const sqlite = new BetterSqlite3(':memory:');
          sqlite.exec(SCHEMA_SQL);
          const invoiceId = `inv_${invoiceSeed}`;
          seedPricingRules(sqlite, { creditIdrRate, bonusThresholdIdr, bonusRatePercent });
          seedPendingTopup(sqlite, { userId, invoiceId, amount });

          const env = makeEnv(makeFakeD1(sqlite) as unknown as D1Database);
          invalidatePricingCache(env.DB);
          const body = { invoice_id: invoiceId, status: 'paid', paid_at: new Date().toISOString() };
          const ts = String(Math.floor(Date.now() / 1000));
          const sig = await signWebhook(env.DOMPETX_WEBHOOK_SECRET, ts, JSON.stringify(body));
          const res = await postWebhook(env, body, ts, sig);
          expect(res.status).toBe(200);

          const tx = sqlite.prepare(`SELECT status FROM topup_transactions WHERE invoice_id = ?`).get(invoiceId) as { status: string };
          expect(tx.status).toBe('paid');

          const expectedTopup = Math.floor(amount / creditIdrRate);
          const expectedBonus = amount >= bonusThresholdIdr
            ? Math.floor((amount * bonusRatePercent) / 100 / creditIdrRate)
            : 0;
          const expectedLedgerBonus = expectedBonus > 0 ? 1 : 0;

          const topupCount = countLedgerByInvoice(sqlite, invoiceId, 'TOPUP');
          const bonusCount = countLedgerByInvoice(sqlite, invoiceId, 'BONUS');
          expect(topupCount).toBe(1);
          expect(bonusCount).toBe(expectedLedgerBonus);

          const walletBalance = getWalletBalance(sqlite, userId);
          expect(walletBalance).toBe(expectedTopup + (expectedBonus > 0 ? expectedBonus : 0));

          sqlite.close();
        },
      ),
      { numRuns: 40 },
    );
  });

  it('Property 20: idempotency across replays and interleaved creditTopup', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          userId: fc.integer({ min: 1, max: 1000 }),
          amount: fc.integer({ min: 1000, max: 500_000 }),
          invoiceSeed: fc.integer({ min: 1, max: 10_000_000 }),
          repeats: fc.integer({ min: 1, max: 6 }),
          directCreditFirst: fc.boolean(),
        }),
        async ({ userId, amount, invoiceSeed, repeats, directCreditFirst }) => {
          const sqlite = new BetterSqlite3(':memory:');
          sqlite.exec(SCHEMA_SQL);
          const invoiceId = `inv_${invoiceSeed}`;
          seedPricingRules(sqlite, { creditIdrRate: 100, bonusThresholdIdr: 100000, bonusRatePercent: 5 });
          seedPendingTopup(sqlite, { userId, invoiceId, amount });

          const db = makeFakeD1(sqlite) as unknown as D1Database;
          const env = makeEnv(db);
          invalidatePricingCache(env.DB);

          if (directCreditFirst) {
            const wallet = createWalletService(db);
            await wallet.creditTopup({
              userId,
              amountIdr: amount,
              creditIdrRate: 100,
              bonusThresholdIdr: 100000,
              bonusRatePercent: 5,
              invoiceId,
            });
          }

          const body = { invoice_id: invoiceId, status: 'paid' };
          const ts = String(Math.floor(Date.now() / 1000));
          const sig = await signWebhook(env.DOMPETX_WEBHOOK_SECRET, ts, JSON.stringify(body));

          for (let i = 0; i < repeats; i++) {
            const res = await postWebhook(env, body, ts, sig);
            expect(res.status).toBe(200);
          }

          const topupCount = countLedgerByInvoice(sqlite, invoiceId, 'TOPUP');
          const bonusCount = countLedgerByInvoice(sqlite, invoiceId, 'BONUS');
          expect(topupCount).toBe(1);
          expect(bonusCount).toBeLessThanOrEqual(1);

          const expectedTopup = Math.floor(amount / 100);
          const expectedBonus = amount >= 100000 ? Math.floor((amount * 5) / 100 / 100) : 0;
          const expectedBalance = expectedTopup + (expectedBonus > 0 ? expectedBonus : 0);
          expect(getWalletBalance(sqlite, userId)).toBe(expectedBalance);

          sqlite.close();
        },
      ),
      { numRuns: 40 },
    );
  });

  it('Property 21: terminal non-paid transitions are safe and non-charging', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          userId: fc.integer({ min: 1, max: 1000 }),
          amount: fc.integer({ min: 10000, max: 200000 }),
          invoiceSeed: fc.integer({ min: 1, max: 10_000_000 }),
          incomingStatus: fc.constantFrom('failed' as const, 'expired' as const),
          initialStatus: fc.constantFrom('pending' as const, 'failed' as const, 'expired' as const, 'paid' as const),
        }),
        async ({ userId, amount, invoiceSeed, incomingStatus, initialStatus }) => {
          const sqlite = new BetterSqlite3(':memory:');
          sqlite.exec(SCHEMA_SQL);
          const invoiceId = `inv_${invoiceSeed}`;
          seedPricingRules(sqlite);
          seedPendingTopup(sqlite, { userId, invoiceId, amount, status: initialStatus });

          const env = makeEnv(makeFakeD1(sqlite) as unknown as D1Database);
          invalidatePricingCache(env.DB);
          const body = { invoice_id: invoiceId, status: incomingStatus };
          const ts = String(Math.floor(Date.now() / 1000));
          const sig = await signWebhook(env.DOMPETX_WEBHOOK_SECRET, ts, JSON.stringify(body));
          const beforeBalance = getWalletBalance(sqlite, userId);

          const res = await postWebhook(env, body, ts, sig);
          expect(res.status).toBe(200);

          const tx = sqlite.prepare(`SELECT status FROM topup_transactions WHERE invoice_id = ?`).get(invoiceId) as { status: string };
          if (initialStatus === 'pending') {
            expect(tx.status).toBe(incomingStatus);
          } else {
            expect(tx.status).toBe(initialStatus);
          }

          const ledgerCount = sqlite.prepare(`SELECT COUNT(1) AS c FROM credit_ledger WHERE idempotency_key = ?`).get(invoiceId) as { c: number };
          expect(ledgerCount.c).toBe(0);
          expect(getWalletBalance(sqlite, userId)).toBe(beforeBalance);

          sqlite.close();
        },
      ),
      { numRuns: 40 },
    );
  });

  it('Property 22: raw_payload masks sensitive fields recursively', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          userId: fc.integer({ min: 1, max: 1000 }),
          amount: fc.integer({ min: 10000, max: 500000 }),
          invoiceSeed: fc.integer({ min: 1, max: 10_000_000 }),
          signatureValue: fc.string({ minLength: 8, maxLength: 32 }),
          apiKeyValue: fc.string({ minLength: 8, maxLength: 32 }),
          nested: fc.jsonValue(),
        }),
        async ({ userId, amount, invoiceSeed, signatureValue, apiKeyValue, nested }) => {
          const sqlite = new BetterSqlite3(':memory:');
          sqlite.exec(SCHEMA_SQL);
          const invoiceId = `inv_${invoiceSeed}`;
          seedPricingRules(sqlite);
          seedPendingTopup(sqlite, { userId, invoiceId, amount, status: 'pending' });

          const env = makeEnv(makeFakeD1(sqlite) as unknown as D1Database);
          invalidatePricingCache(env.DB);
          const body = {
            invoice_id: invoiceId,
            status: 'pending',
            signature: signatureValue,
            api_key: apiKeyValue,
            nested: {
              api_key: `${apiKeyValue}_nested`,
              level2: {
                signature_token: `${signatureValue}_deep`,
                payload: nested,
              },
            },
          };
          const ts = String(Math.floor(Date.now() / 1000));
          const sig = await signWebhook(env.DOMPETX_WEBHOOK_SECRET, ts, JSON.stringify(body));
          const res = await postWebhook(env, body, ts, sig);
          expect(res.status).toBe(200);

          const row = sqlite.prepare(`SELECT raw_payload FROM topup_transactions WHERE invoice_id = ?`).get(invoiceId) as { raw_payload: string | null };
          expect(row.raw_payload).toBeTruthy();
          const stored = row.raw_payload ?? '';
          expect(stored.includes(signatureValue)).toBe(false);
          expect(stored.includes(apiKeyValue)).toBe(false);

          const parsed = JSON.parse(stored) as unknown;
          const sensitiveKeywords = ['secret', 'token', 'signature', 'api_key', 'password', 'auth'];
          const assertMasked = (value: unknown) => {
            if (Array.isArray(value)) {
              for (const v of value) assertMasked(v);
              return;
            }
            if (value && typeof value === 'object') {
              for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
                const lower = k.toLowerCase();
                const isSensitive = sensitiveKeywords.some((x) => lower.includes(x));
                if (isSensitive) {
                  expect(v).toBe('[REDACTED]');
                } else {
                  assertMasked(v);
                }
              }
            }
          };

          assertMasked(parsed);
          sqlite.close();
        },
      ),
      { numRuns: 30 },
    );
  });
});
