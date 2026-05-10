// Feature: saas-topup-billing, Property 28-30: Abuse_Guard
import fc from 'fast-check';
import { describe, it, expect } from 'vitest';

import {
  createAbuseGuard,
  FingerprintRequiredError,
  RateLimitedError,
} from '../abuse_guard.js';

class InMemoryKv {
  private readonly data = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.data.has(key) ? this.data.get(key)! : null;
  }

  async put(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  has(key: string): boolean {
    return this.data.has(key);
  }
}

class AuditDb {
  ipBlockAuditCount = 0;

  prepare(sql: string) {
    return {
      _sql: sql,
      _params: [] as unknown[],
      bind(...p: unknown[]) {
        this._params = p;
        return this;
      },
      async run() {
        if (this._sql.includes("'ip_block'")) {
          // eslint-disable-next-line @typescript-eslint/no-this-alias
          const self = (this as unknown as { __owner?: AuditDb }).__owner;
          if (self) self.ipBlockAuditCount += 1;
        }
        return { success: true, meta: { changes: 1 }, results: [] };
      },
    } as unknown as D1PreparedStatement;
  }

  attachOwner(stmt: D1PreparedStatement): D1PreparedStatement {
    (stmt as unknown as { __owner?: AuditDb }).__owner = this;
    return stmt;
  }
}

function makeDb(): D1Database {
  const db = new AuditDb();
  return {
    prepare(sql: string) {
      return db.attachOwner(db.prepare(sql));
    },
  } as unknown as D1Database;
}

function makeContext(args: {
  userId: number;
  ip?: string;
  fingerprint?: string | null;
  kv: InMemoryKv;
  db: D1Database;
}) {
  const vars = new Map<string, unknown>();
  const fingerprintHeader = args.fingerprint;
  return {
    env: {
      BILLING_RATE_LIMITER: args.kv as unknown as KVNamespace,
      KV: args.kv as unknown as KVNamespace,
      DB: args.db,
    },
    req: {
      header(name: string): string | undefined {
        const key = name.toLowerCase();
        if (key === 'cf-connecting-ip') return args.ip;
        if (key === 'x-fingerprint') return fingerprintHeader ?? undefined;
        return undefined;
      },
    },
    get(key: string): unknown {
      if (key === 'userPayload') return { user_id: args.userId };
      return vars.get(key);
    },
    set(key: string, value: unknown): void {
      vars.set(key, value);
    },
  } as unknown as import('hono').Context<HonoCustomType>;
}

describe('Abuse_Guard properties', () => {
  it('Property 28: user-level quote/create limits', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          mode: fc.constantFrom('quote' as const, 'create' as const),
          total: fc.integer({ min: 1, max: 40 }),
        }),
        async ({ mode, total }) => {
          const kv = new InMemoryKv();
          const db = makeDb();
          const guard = createAbuseGuard();
          const c = makeContext({ userId: 1, ip: '203.0.113.10', fingerprint: 'fp-1', kv, db });

          let failures = 0;
          for (let i = 0; i < total; i++) {
            try {
              if (mode === 'quote') {
                await guard.checkTopupQuote(c);
              } else {
                await guard.checkTopupCreate(c);
              }
            } catch (err) {
              failures += 1;
              expect(err).toBeInstanceOf(RateLimitedError);
            }
          }

          const cap = mode === 'quote' ? 30 : 5;
          const expectedFailures = Math.max(0, total - cap);
          expect(failures).toBe(expectedFailures);
        },
      ),
      { numRuns: 80 },
    );
  });

  it('Property 29: IP new-user guard blocks after >10 unique users and logs once', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 15 }), async (distinctUsers) => {
        const kv = new InMemoryKv();
        const dbImpl = new AuditDb();
        const db = {
          prepare(sql: string) {
            return dbImpl.attachOwner(dbImpl.prepare(sql));
          },
        } as unknown as D1Database;
        const guard = createAbuseGuard();
        const ip = '198.51.100.7';

        let blockedCount = 0;
        for (let uid = 1; uid <= distinctUsers; uid++) {
          const c = makeContext({ userId: uid, ip, fingerprint: `fp-${uid}`, kv, db });
          try {
            await guard.checkTopupCreate(c);
          } catch (err) {
            expect(err).toBeInstanceOf(RateLimitedError);
            blockedCount += 1;
          }
        }

        if (distinctUsers <= 10) {
          expect(blockedCount).toBe(0);
          expect(dbImpl.ipBlockAuditCount).toBe(0);
          expect(kv.has(`rl:ipblock:${ip}`)).toBe(false);
        } else {
          expect(blockedCount).toBeGreaterThanOrEqual(1);
          expect(dbImpl.ipBlockAuditCount).toBe(1);
          expect(kv.has(`rl:ipblock:${ip}`)).toBe(true);
        }
      }),
      { numRuns: 60 },
    );
  });

  it('Property 30: fingerprint is required (missing/blank rejected, valid accepted)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constant(undefined),
          fc.constant(''),
          fc.constant('   '),
          fc.string({ minLength: 1, maxLength: 64 }).filter((s) => s.trim().length > 0),
        ),
        async (fpHeader) => {
          const kv = new InMemoryKv();
          const db = makeDb();
          const guard = createAbuseGuard();
          const c = makeContext({ userId: 1, ip: '203.0.113.11', fingerprint: fpHeader ?? null, kv, db });

          const shouldReject = fpHeader === undefined || fpHeader.trim() === '';
          if (shouldReject) {
            await expect(guard.requireFingerprint(c)).rejects.toBeInstanceOf(FingerprintRequiredError);
            expect(c.get('fingerprint_hash')).toBeUndefined();
          } else {
            const hash = await guard.requireFingerprint(c);
            expect(typeof hash).toBe('string');
            expect(hash).toMatch(/^[a-f0-9]{64}$/);
            expect(c.get('fingerprint_hash')).toBe(hash);
          }
        },
      ),
      { numRuns: 80 },
    );
  });
});
