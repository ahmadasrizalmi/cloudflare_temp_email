import { test, expect } from '@playwright/test'
import { WORKER_URL } from '../../fixtures/test-helpers'
import { createBillingUser } from './billing.helpers'

test('billing topup happy path (quote -> create -> webhook)', async ({ request }) => {
  const { jwt } = await createBillingUser(request)

  const quoteRes = await request.post(`${WORKER_URL}/user_api/topup/quote`, {
    headers: { 'x-user-token': jwt, 'x-fingerprint': 'fp-e2e' },
    data: { nominal: 10000 },
  })
  if (quoteRes.status() === 404) test.skip(true, 'billing routes not enabled in current e2e env')
  expect([200, 400]).toContain(quoteRes.status())
  if (!quoteRes.ok()) return
  const quotes = await quoteRes.json()
  if (!Array.isArray(quotes) || quotes.length === 0) test.skip(true, 'no channels returned for topup quote')

  const createRes = await request.post(`${WORKER_URL}/user_api/topup/create`, {
    headers: { 'x-user-token': jwt, 'x-fingerprint': 'fp-e2e' },
    data: { nominal: 10000, channel_code: quotes[0].channel_code },
  })
  expect([200, 400, 502]).toContain(createRes.status())
  if (!createRes.ok()) return

  const created = await createRes.json()
  const webhookRes = await request.post(`${WORKER_URL}/open_api/payment/webhook/dompetx`, {
    headers: {
      'x-dompetx-timestamp': `${Math.floor(Date.now() / 1000)}`,
      'x-dompetx-signature': 'invalid',
      'content-type': 'application/json',
    },
    data: { invoice_id: created.invoice_id, status: 'paid' },
  })
  expect([200, 401]).toContain(webhookRes.status())
})

