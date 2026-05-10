/**
 * Public payment channels endpoint — `GET /open_api/payment_channels`
 *
 * No auth. Delegates to Channel_Cache.listPublic(nominal) and explicitly
 * projects only safe fields as defense-in-depth (Channel_Cache already
 * strips sensitive fields, but we re-project here to guarantee nothing
 * unexpected leaks out to an unauthenticated caller).
 *
 * Feature: saas-topup-billing
 * Requirements: 16.1, 16.2, 16.3, 16.4, 16.5
 */

import { Hono } from 'hono';

import {
    createChannelCache,
    type DompetxChannelClient,
} from '../billing/channel_cache';
import { createDompetxClient } from '../billing/dompetx_client';
import type { PaymentChannel } from '../models/billing';

const api = new Hono<HonoCustomType>();

/**
 * Explicitly pick only the fields that are safe to expose publicly.
 * This is defense-in-depth on top of Channel_Cache's sensitive-field stripping.
 */
function toPublicView(ch: PaymentChannel) {
    return {
        channel_code: ch.channel_code,
        name: ch.name,
        group: ch.group,
        min: ch.min,
        max: ch.max,
        fee_type: ch.fee_type,
        fee_value: ch.fee_value,
        fee_fixed: ch.fee_fixed,
        fee_bearer: ch.fee_bearer,
        is_active: ch.is_active,
        icon_url: ch.icon_url,
    };
}

/**
 * Parse the optional `nominal` query parameter.
 * Returns `undefined` when not provided, a parsed integer when valid,
 * or `null` to signal a malformed value (handler returns HTTP 400).
 */
function parseNominal(raw: string | undefined): number | undefined | null {
    if (raw === undefined || raw === '') return undefined;
    // Must be a non-negative integer
    if (!/^\d+$/.test(raw)) return null;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
}

/**
 * Build a DompetX client, or a safe fallback that throws on use.
 *
 * Rationale: this endpoint is public and read-only. It should still serve
 * cached channel data when DompetX secrets are not configured; the
 * background refresh simply cannot run and the stale-while-revalidate
 * failure is swallowed (logged) by the executionCtx.waitUntil handler.
 *
 * Note: the `DompetxChannel` type exported by channel_cache.ts has an
 * `[key: string]: unknown` index signature (so that any vendor-specific
 * fields can be stripped), while the dompetx_client's `DompetxChannel`
 * does not. We wrap the real client so the returned rows are assignable
 * to the cache's channel type without losing any fields.
 */
function buildDompetxClient(env: Bindings): DompetxChannelClient {
    try {
        const real = createDompetxClient(env);
        return {
            async listChannels() {
                const channels = await real.listChannels();
                // Spread each row so the result carries the index signature
                // required by DompetxChannelClient.listChannels.
                return channels.map((ch) => ({ ...ch }));
            },
        };
    } catch {
        // Fallback: calling listChannels() will fail the background refresh,
        // but cached data can still be returned to the caller.
        return {
            async listChannels() {
                throw new Error('DompetX secrets are not configured');
            },
        };
    }
}

api.get('/open_api/payment_channels', async (c) => {
    // Parse and validate the optional nominal query parameter
    const nominal = parseNominal(c.req.query('nominal'));
    if (nominal === null) {
        return c.text('Invalid nominal parameter', 400);
    }

    // Build a Channel_Cache bound to this request's env.
    // The DompetX client is only used when the cache is stale and a
    // background refresh is triggered via ctx.waitUntil.
    const dompetx = buildDompetxClient(c.env);
    const cache = createChannelCache(c.env.DB, dompetx);

    // Pass executionCtx so stale-while-revalidate can schedule a
    // background refresh without blocking the response.
    const channels = await cache.listPublic(nominal, c.executionCtx);

    return c.json(channels.map(toPublicView));
});

export { api };
