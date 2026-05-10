import { test, expect } from '@playwright/test'
import { WORKER_URL } from '../../fixtures/test-helpers'
import { createBillingUser } from './billing.helpers'

test('billing domain cost preview ordering', async ({ request }) => {
  const { jwt } = await createBillingUser(request)
  const res = await request.get(`${WORKER_URL}/user_api/billing/domains`, {
    headers: { 'x-user-token': jwt },
  })
  if (res.status() === 404) test.skip(true, 'billing domain preview not enabled')
  expect(res.ok()).toBe(true)
  const rows = await res.json()
  const com = rows.find((r: any) => String(r.domain_suffix || r.domain).endsWith('.com'))
  const web = rows.find((r: any) => String(r.domain_suffix || r.domain).endsWith('.web.id'))
  if (com && web) {
    expect(Number(com.credit_cost)).toBeGreaterThanOrEqual(Number(web.credit_cost))
  }
})

