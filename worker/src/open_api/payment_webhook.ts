import { Hono } from 'hono';
import i18n from '../i18n';
import { createDompetxClient } from '../billing/dompetx_client';
import { createWalletService } from '../billing/wallet_service';
import { createPricingEngine } from '../billing/pricing_engine';

const api = new Hono<HonoCustomType>();

function jsonError(c: any, code: string, message: string, status: number) {
    return c.json({ code, message }, status);
}

api.post('/open_api/payment/webhook/dompetx', async (c) => {
    const msgs = i18n.getMessagesbyContext(c);
    const rawBody = await c.req.text();
    const timestamp = c.req.header('x-dompetx-timestamp') || '';
    const signature = c.req.header('x-dompetx-signature') || '';

    let dompetx;
    try {
        dompetx = createDompetxClient(c.env);
    } catch (err) {
        return jsonError(c, 'dompetx_unavailable', (err as Error).message, 503);
    }

    const isTsValid = dompetx.isTimestampWithinWindow(timestamp);
    const isSigValid = signature
        ? await dompetx.verifyWebhookSignature(rawBody, timestamp, signature)
        : false;
    if (!isTsValid || !isSigValid) {
        await c.env.DB.prepare(
            `INSERT INTO billing_audit_logs
               (admin_id, event_type, target_user_id, rule_key, old_value, new_value, reason, metadata, created_at)
             VALUES (NULL, 'webhook_invalid_signature', NULL, NULL, NULL, NULL, ?, ?, CURRENT_TIMESTAMP)`,
        )
            .bind(
                !isTsValid ? 'timestamp_window_violation' : 'signature_mismatch',
                JSON.stringify({
                    has_signature: Boolean(signature),
                    timestamp,
                    ip: c.req.header('cf-connecting-ip') ?? null,
                }),
            )
            .run();
        return jsonError(c, 'invalid_webhook_signature', msgs.OperationFailedMsg, 401);
    }

    let body: any;
    try {
        body = JSON.parse(rawBody);
    } catch {
        return jsonError(c, 'invalid_input', msgs.InvalidInputMsg, 400);
    }

    const invoiceId: string = body?.invoice_id;
    const providerStatus: string = body?.status;
    if (!invoiceId || typeof invoiceId !== 'string') {
        return jsonError(c, 'invalid_input', msgs.InvalidInputMsg, 400);
    }

    const tx = await c.env.DB.prepare(
        `SELECT id, user_id, amount, status
           FROM topup_transactions
          WHERE invoice_id = ?
          LIMIT 1`,
    )
        .bind(invoiceId)
        .first<{ id: number; user_id: number; amount: number; status: string }>();

    if (!tx) {
        return jsonError(c, 'invoice_not_found', msgs.InvoiceNotFoundMsg, 404);
    }

    const canonical =
        providerStatus === 'paid' || providerStatus === 'failed' || providerStatus === 'expired'
            ? providerStatus
            : 'pending';

    await c.env.DB.prepare(
        `UPDATE topup_transactions
            SET raw_payload = ?, updated_at = datetime('now')
          WHERE id = ?`,
    )
        .bind(rawBody, tx.id)
        .run();

    if (canonical === 'paid') {
        if (tx.status !== 'paid') {
            const pricing = createPricingEngine(c.env.DB);
            const wallet = createWalletService(c.env.DB);
            const [creditIdrRate, bonusThresholdIdr, bonusRatePercent] = await Promise.all([
                pricing.getNumber('credit_idr_rate'),
                pricing.getNumber('bonus_threshold_idr'),
                pricing.getNumber('bonus_rate_percent'),
            ]);

            await wallet.creditTopup({
                userId: tx.user_id,
                amountIdr: tx.amount,
                creditIdrRate,
                bonusThresholdIdr,
                bonusRatePercent,
                invoiceId,
            });
        }

        await c.env.DB.prepare(
            `UPDATE topup_transactions
                SET status = 'paid',
                    paid_at = COALESCE(?, datetime('now')),
                    updated_at = datetime('now')
              WHERE id = ?`,
        )
            .bind(typeof body?.paid_at === 'string' ? body.paid_at : null, tx.id)
            .run();
    } else if (canonical === 'failed' || canonical === 'expired') {
        await c.env.DB.prepare(
            `UPDATE topup_transactions
                SET status = ?, updated_at = datetime('now')
              WHERE id = ? AND status = 'pending'`,
        )
            .bind(canonical, tx.id)
            .run();
    }

    return c.json({ ok: true });
});

export { api };
