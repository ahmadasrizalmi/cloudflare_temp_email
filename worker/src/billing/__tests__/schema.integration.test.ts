import fs from 'node:fs';
import path from 'node:path';

import BetterSqlite3, { type Database as BetterSqlite3Database } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const MIGRATION_SQL = fs.readFileSync(
    path.resolve(process.cwd(), '../db/2026-05-15-billing-wallet.sql'),
    'utf8',
);

function setupDbWithUsers(userCount = 3): BetterSqlite3Database {
    const db = new BetterSqlite3(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          user_email TEXT UNIQUE NOT NULL,
          password TEXT NOT NULL
        );
    `);
    const ins = db.prepare('INSERT INTO users (id, user_email, password) VALUES (?, ?, ?)');
    for (let i = 1; i <= userCount; i++) {
        ins.run(i, `u${i}@example.test`, 'x');
    }
    db.exec(MIGRATION_SQL);
    return db;
}

describe('billing schema integration', () => {
    it('enforces UNIQUE(invoice_id) and UNIQUE(provider_reference)', () => {
        const db = setupDbWithUsers(1);
        const insert = db.prepare(`
            INSERT INTO topup_transactions
              (user_id, invoice_id, provider_reference, channel_code, amount, fee, gross_amount, fee_bearer, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        insert.run(1, 'inv-1', 'ref-1', 'QRIS', 10000, 0, 10000, 'customer', 'pending');

        expect(() =>
            insert.run(1, 'inv-1', 'ref-2', 'QRIS', 10000, 0, 10000, 'customer', 'pending'),
        ).toThrow();
        expect(() =>
            insert.run(1, 'inv-2', 'ref-1', 'QRIS', 10000, 0, 10000, 'customer', 'pending'),
        ).toThrow();
        db.close();
    });

    it('enforces CHECK(balance_credit >= 0)', () => {
        const db = setupDbWithUsers(1);
        expect(() =>
            db.prepare('UPDATE wallets SET balance_credit = -1 WHERE user_id = 1').run(),
        ).toThrow();
        db.close();
    });

    it('migration back-fill is idempotent for wallets', () => {
        const db = new BetterSqlite3(':memory:');
        db.pragma('foreign_keys = ON');
        db.exec(`
          CREATE TABLE users (
            id INTEGER PRIMARY KEY,
            user_email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL
          );
        `);
        const ins = db.prepare('INSERT INTO users (id, user_email, password) VALUES (?, ?, ?)');
        for (let i = 1; i <= 20; i++) {
            ins.run(i, `u${i}@example.test`, 'x');
        }

        db.exec(MIGRATION_SQL);
        const first = db.prepare('SELECT COUNT(*) AS c FROM wallets').get() as { c: number };
        db.exec(MIGRATION_SQL);
        const second = db.prepare('SELECT COUNT(*) AS c FROM wallets').get() as { c: number };

        expect(first.c).toBe(20);
        expect(second.c).toBe(20);
        db.close();
    });
});

