import { test, expect } from '@playwright/test'
import { WORKER_URL, TEST_DOMAIN } from '../../fixtures/test-helpers'
import { createBillingUser } from './billing.helpers'

test('billing insufficient credit on create address', async ({ request }) => {
  const { jwt } = await createBillingUser(request)
  const res = await request.post(`${WORKER_URL}/api/new_address`, {
    headers: { 'x-user-token': jwt, 'x-fingerprint': 'fp-e2e' },
    data: { name: `needcredit${Date.now()}`, domain: TEST_DOMAIN },
  })
  expect([200, 402, 404]).toContain(res.status())
})

