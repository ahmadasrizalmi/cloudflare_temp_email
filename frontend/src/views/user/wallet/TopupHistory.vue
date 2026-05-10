<script setup>
import { onMounted, ref } from 'vue'
import { useMessage } from 'naive-ui'
import { useScopedI18n } from '@/i18n/app'
import { getTopupHistory } from '../../../api/billing'
import { 
  HistoryRound,
  FilterListRound,
  CheckCircleRound,
  PendingRound,
  CancelRound,
  TimerRound
} from '@vicons/material'

const message = useMessage()
const { t } = useScopedI18n('views.user.wallet.TopupHistory')
const rows = ref([])
const nextCursor = ref('')
const status = ref('')
const loading = ref(false)

const load = async (append = false) => {
  try {
    loading.value = true
    const page = await getTopupHistory({ limit: 20, cursor: append ? nextCursor.value : '', status: status.value })
    const items = page.items || []
    rows.value = append ? [...rows.value, ...items] : items
    nextCursor.value = page.next_cursor || ''
  } catch (err) {
    message.error(err.message || t('loadTopupHistoryFailed'))
  } finally {
    loading.value = false
  }
}

const getStatusType = (s) => {
  if (s === 'paid') return 'success'
  if (s === 'pending') return 'warning'
  if (s === 'failed' || s === 'cancelled') return 'error'
  return 'default'
}

const getStatusIcon = (s) => {
  if (s === 'paid') return CheckCircleRound
  if (s === 'pending') return PendingRound
  if (s === 'failed' || s === 'cancelled') return CancelRound
  if (s === 'expired') return TimerRound
  return HistoryRound
}

onMounted(() => load(false))
</script>

<template>
  <div class="history-page">
    <n-card :title="t('topupHistory')" class="history-card">
      <template #header-extra>
        <n-icon size="24" :component="HistoryRound" />
      </template>

      <n-space vertical size="large">
        <n-input-group>
          <n-input-group-label>
            <n-icon :component="FilterListRound" />
          </n-input-group-label>
          <n-select
            v-model:value="status"
            :options="[
              { label: t('all'), value: '' },
              { label: t('pending'), value: 'pending' },
              { label: t('paidStatus'), value: 'paid' },
              { label: t('failed'), value: 'failed' },
              { label: t('expired'), value: 'expired' },
              { label: t('cancelled'), value: 'cancelled' }
            ]"
            @update:value="load(false)"
            style="width: 200px"
          />
        </n-input-group>

        <n-table striped class="history-table">
          <thead>
            <tr>
              <th>{{ t('invoice') }}</th>
              <th>{{ t('amount') }}</th>
              <th>{{ t('status') }}</th>
              <th>{{ t('created') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.id">
              <td>
                <n-text depth="3" class="invoice-id">{{ r.invoice_id }}</n-text>
                <div class="channel-label">{{ r.channel_code }}</div>
              </td>
              <td>
                <div class="amount-val">Rp {{ r.amount.toLocaleString('id-ID') }}</div>
                <n-text depth="3" class="gross-val">Gross: Rp {{ r.gross_amount.toLocaleString('id-ID') }}</n-text>
              </td>
              <td>
                <n-tag :type="getStatusType(r.status)" size="small" round>
                  <template #icon>
                    <n-icon :component="getStatusIcon(r.status)" />
                  </template>
                  {{ t(r.status === 'paid' ? 'paidStatus' : r.status) }}
                </n-tag>
              </td>
              <td>
                <n-text depth="3" class="date-text">{{ r.created_at }}</n-text>
              </td>
            </tr>
          </tbody>
        </n-table>

        <n-empty v-if="rows.length === 0 && !loading" :description="t('noHistory')" />

        <div class="load-more" v-if="nextCursor">
          <n-button :loading="loading" @click="load(true)" secondary block>
            {{ t('loadMore') }}
          </n-button>
        </div>
      </n-space>
    </n-card>
  </div>
</template>

<style scoped>
.history-page {
  max-width: 900px;
  margin: 0 auto;
  padding: 12px;
}

.history-card {
  border-radius: 16px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.05);
}

.history-table th {
  background: rgba(0, 0, 0, 0.02);
  font-weight: 700;
}

.invoice-id {
  font-family: monospace;
  font-size: 0.85rem;
}

.channel-label {
  font-size: 0.75rem;
  color: var(--n-primary-color);
  font-weight: 600;
}

.amount-val {
  font-weight: 600;
}

.gross-val {
  font-size: 0.75rem;
}

.date-text {
  font-size: 0.85rem;
}

.load-more {
  margin-top: 24px;
}
</style>
