import { describe, expect, it, vi, beforeEach } from 'vitest'

const requestMock = vi.fn()
const axiosCreate = vi.fn(() => ({ request: requestMock }))

vi.mock('axios', () => ({
  default: { create: axiosCreate },
}))

vi.mock('../utils/fingerprint', () => ({
  getFingerprint: vi.fn(async () => 'fp-test'),
}))

describe('api.fetch billing 402 behavior', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    ;(globalThis as any).useMessage = () => ({ error: vi.fn(), success: vi.fn() })
  })

  it('refreshes wallet endpoint when paid action returns 402', async () => {
    requestMock
      .mockResolvedValueOnce({ status: 402, data: { code: 'insufficient_credit' } })
      .mockResolvedValueOnce({ status: 200, data: { balance_credit: 99, balance_idr_ref: 9900, updated_at: 'now' } })

    const mod = await import('./index.js')
    await expect(mod.api.fetch('/api/new_address', { method: 'POST', body: {} }))
      .rejects.toThrow('[402]')

    expect(requestMock).toHaveBeenCalledTimes(2)
    expect(requestMock.mock.calls[1][0]).toBe('/user_api/wallet')
  }, 20000)
})
