import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { describe, expect, it, vi, beforeEach } from 'vitest'

import Topup from './Topup.vue'
import i18n from '../../../i18n'

const quoteTopup = vi.fn()
const createTopup = vi.fn()
const getTopupHistory = vi.fn()
const getWallet = vi.fn()

vi.mock('../../../api/billing', () => ({
  quoteTopup: (...args: unknown[]) => quoteTopup(...args),
  createTopup: (...args: unknown[]) => createTopup(...args),
  getTopupHistory: (...args: unknown[]) => getTopupHistory(...args),
  getWallet: (...args: unknown[]) => getWallet(...args),
}))

describe('Topup.vue', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(globalThis as any).useMessage = () => ({ error: vi.fn(), success: vi.fn() })
    quoteTopup.mockResolvedValue([
      { channel_code: 'QRIS', name: 'QRIS', estimated_fee: 1000, gross_amount: 11000, fee_bearer: 'customer' },
    ])
  })

  it('loads quote on mount and clicking preset triggers quote with preset nominal', async () => {
    const wrapper = mount(Topup, {
      global: {
        plugins: [i18n],
        stubs: {
          'n-space': { template: '<div><slot/></div>' },
          'n-card': { template: '<div><slot/></div>' },
          'n-radio-group': { template: '<div><slot/></div>' },
          'n-radio': { template: '<label><slot/></label>' },
          'n-input-number': { template: '<input />' },
          'n-button': { template: '<button @click="$emit(\'click\')"><slot/></button>' },
        },
      },
    })
    await nextTick()
    expect(quoteTopup).toHaveBeenCalled()

    const buttons = wrapper.findAll('button')
    await buttons[2].trigger('click') // Rp50.000
    expect(quoteTopup).toHaveBeenLastCalledWith(50000)
  })
})
