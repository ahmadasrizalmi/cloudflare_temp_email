import type { APIRequestContext } from '@playwright/test'
import { WORKER_URL, TEST_DOMAIN } from '../../fixtures/test-helpers'

export async function createBillingUser(request: APIRequestContext) {
  const email = `billing-${Date.now()}@${TEST_DOMAIN}`
  const password = 'billing-pass-123'
  await request.post(`${WORKER_URL}/admin/user_settings`, {
    data: { enable: true, enableMailVerify: false },
  })
  const registerRes = await request.post(`${WORKER_URL}/user_api/register`, {
    data: { email, password },
  })
  if (!registerRes.ok()) throw new Error(`register failed: ${registerRes.status()} ${await registerRes.text()}`)
  const loginRes = await request.post(`${WORKER_URL}/user_api/login`, { data: { email, password } })
  if (!loginRes.ok()) throw new Error(`login failed: ${loginRes.status()} ${await loginRes.text()}`)
  const body = await loginRes.json()
  return { email, jwt: body.jwt as string }
}

