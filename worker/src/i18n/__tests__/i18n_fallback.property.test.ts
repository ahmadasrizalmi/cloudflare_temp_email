// Feature: saas-topup-billing, Property 37: i18n fallback
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import i18n from '../index.js';
import en from '../en.js';

describe('i18n fallback property (P37)', () => {
    it('falls back to en for unknown/unsupported locale', async () => {
        const keys = Object.keys(en) as Array<keyof typeof en>;
        await fc.assert(
            fc.asyncProperty(
                fc.constantFrom(...keys),
                fc.string({ minLength: 1, maxLength: 8 }).filter((s) => !['en', 'zh', 'id'].includes(s)),
                async (key, locale) => {
                    const msg = i18n.getMessages(locale as string);
                    expect(msg[key]).toBe(en[key]);
                },
            ),
            { numRuns: 100 },
        );
    });

    it('returns defined keys for supported locales and undefined for unknown keys', async () => {
        const keys = Object.keys(en) as Array<keyof typeof en>;
        await fc.assert(
            fc.asyncProperty(
                fc.constantFrom(...keys),
                fc.constantFrom('en', 'zh', 'id'),
                async (key, locale) => {
                    const msg = i18n.getMessages(locale);
                    expect(msg[key]).toBeTypeOf('string');
                    expect((msg as Record<string, string>)['__unknown_key__']).toBeUndefined();
                },
            ),
            { numRuns: 100 },
        );
    });
});

