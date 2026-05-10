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

export const createTopup = async (nominal, channel_code) =>
  api.fetch('/user_api/topup/create', {
    method: 'POST',
    body: JSON.stringify({ nominal, channel_code }),
  })

export const getTopupHistory = async ({ limit = 20, cursor = '', status = '' } = {}) => {
  const q = new URLSearchParams()
  if (limit) q.set('limit', String(limit))
  if (cursor) q.set('cursor', cursor)
  if (status) q.set('status', status)
  return api.fetch(`/user_api/topup/history?${q.toString()}`)
}

