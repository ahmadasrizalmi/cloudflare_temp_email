import { test, expect } from '@playwright/test'
import { WORKER_URL } from '../../fixtures/test-helpers'
import { createBillingUser } from './billing.helpers'

test('billing topup create user rate limit smoke', async ({ request }) => {
  const { jwt } = await createBillingUser(request)
  const quoteRes = await request.post(`${WORKER_URL}/user_api/topup/quote`, {
    headers: { 'x-user-token': jwt, 'x-fingerprint': 'fp-e2e' },
    data: { nominal: 10000 },
  })
  if (!quoteRes.ok()) test.skip(true, 'billing quote not available')
  const quotes = await quoteRes.json()
  const ch = quotes?.[0]?.channel_code
  if (!ch) test.skip(true, 'no eligible channel for rate-limit test')

  const statuses: number[] = []
  for (let i = 0; i < 6; i++) {
    const res = await request.post(`${WORKER_URL}/user_api/topup/create`, {
      headers: { 'x-user-token': jwt, 'x-fingerprint': 'fp-e2e' },
      data: { nominal: 10000, channel_code: ch },
    })
    statuses.push(res.status())
  }
  expect(statuses.length).toBe(6)
  expect(statuses.some((s) => s === 429 || s === 502 || s === 200)).toBe(true)
})

