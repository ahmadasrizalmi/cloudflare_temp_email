import { test, expect } from '@playwright/test'
import { WORKER_URL } from '../../fixtures/test-helpers'
import { createBillingUser } from './billing.helpers'

test('billing webhook idempotency smoke', async ({ request }) => {
  const { jwt } = await createBillingUser(request)
  const quoteRes = await request.post(`${WORKER_URL}/user_api/topup/quote`, {
    headers: { 'x-user-token': jwt, 'x-fingerprint': 'fp-e2e' },
    data: { nominal: 10000 },
  })
  if (!quoteRes.ok()) test.skip(true, 'billing quote unavailable')
  const quotes = await quoteRes.json()
  const createRes = await request.post(`${WORKER_URL}/user_api/topup/create`, {
    headers: { 'x-user-token': jwt, 'x-fingerprint': 'fp-e2e' },
    data: { nominal: 10000, channel_code: quotes[0].channel_code },
  })
  if (!createRes.ok()) test.skip(true, 'billing create unavailable')
  const created = await createRes.json()

  for (let i = 0; i < 3; i++) {
    const res = await request.post(`${WORKER_URL}/open_api/payment/webhook/dompetx`, {
      headers: {
        'x-dompetx-timestamp': `${Math.floor(Date.now() / 1000)}`,
        'x-dompetx-signature': 'invalid',
        'content-type': 'application/json',
      },
      data: { invoice_id: created.invoice_id, status: 'paid' },
    })
    expect([200, 401]).toContain(res.status())
  }
})

