import { api } from './index'

export const getWallet = async () => api.fetch('/user_api/wallet')

export const getLedger = async ({ limit = 20, cursor = '' } = {}) => {
  const q = new URLSearchParams()
  if (limit) q.set('limit', String(limit))
  if (cursor) q.set('cursor', cursor)
  return api.fetch(`/user_api/wallet/ledger?${q.toString()}`)
}

export const getDomains = async () => api.fetch('/user_api/billing/domains')

export const quoteTopup = async (nominal) =>
  api.fetch('/user_api/topup/quote', {
    method: 'POST',
    body: JSON.stringify({ nominal }),
  })

export const createTopup = async (nominal, channel_code, voucher_code = '') =>
  api.fetch('/user_api/topup/create', {
    method: 'POST',
    body: JSON.stringify({ nominal, channel_code, voucher_code }),
  })

export const getTopupHistory = async ({ limit = 20, cursor = '', status = '' } = {}) => {
  const q = new URLSearchParams()
  if (limit) q.set('limit', String(limit))
  if (cursor) q.set('cursor', cursor)
  if (status) q.set('status', status)
  return api.fetch(`/user_api/topup/history?${q.toString()}`)
}

// Admin API
export const getAdminPricingRules = async () => api.fetch('/admin/billing/pricing_rules')
export const saveAdminPricingRule = async (rule) => api.fetch('/admin/billing/pricing_rules', {
  method: 'POST',
  body: JSON.stringify(rule)
})
export const getAdminTransactions = async ({ limit = 20, offset = 0, query = '' } = {}) => {
  const q = new URLSearchParams()
  if (limit) q.set('limit', String(limit))
  if (offset) q.set('offset', String(offset))
  if (query) q.set('query', query)
  return api.fetch(`/admin/billing/topup_transactions?${q.toString()}`)
}
export const refreshAdminChannels = async () => api.fetch('/admin/billing/refresh_channels', { method: 'POST' })
export const adjustAdminCredit = async ({ user_id, amount_credits, reason }) => api.fetch('/admin/billing/credit_adjust', {
  method: 'POST',
  body: JSON.stringify({ user_id, amount_credits, reason })
})
export const getAdminKPIs = async () => api.fetch('/admin/billing/kpis')
export const getAdminDomains = async () => api.fetch('/admin/billing/domains')
export const addAdminDomain = async (domain) => api.fetch('/admin/billing/domains', {
  method: 'POST',
  body: JSON.stringify({ domain })
})
export const deleteAdminDomain = async (id) => api.fetch(`/admin/billing/domains/${id}`, { method: 'DELETE' })

// Vouchers
export const getAdminVouchers = async () => api.fetch('/admin/billing/vouchers')
export const createAdminVoucher = async (data) => api.fetch('/admin/billing/vouchers', {
  method: 'POST',
  body: JSON.stringify(data)
})
export const deleteAdminVoucher = async (id) => api.fetch(`/admin/billing/vouchers/${id}`, { method: 'DELETE' })

export const getFreeQuota = async () => api.fetch('/user_api/billing/free_quota')
