<script setup>
import { onMounted, ref } from 'vue'
import { useMessage } from 'naive-ui'
import { useScopedI18n } from '@/i18n/app'
import { getLedger } from '../../../api/billing'
import { 
  FormatListBulletedRound, 
  ArrowDownwardRound,
  ArrowUpwardRound,
  EventNoteRound
} from '@vicons/material'

const message = useMessage()
const { t } = useScopedI18n('views.user.wallet.Ledger')
const rows = ref([])
const nextCursor = ref('')
const loading = ref(false)

const load = async (append = false) => {
  try {
    loading.value = true
    const page = await getLedger({ limit: 20, cursor: append ? nextCursor.value : '' })
    const items = page.items || []
    rows.value = append ? [...rows.value, ...items] : items
    nextCursor.value = page.next_cursor || ''
  } catch (err) {
    message.error(err.message || t('loadLedgerFailed'))
  } finally {
    loading.value = false
  }
}

const getIcon = (type) => {
  if (type === 'DEBIT') return ArrowDownwardRound
  if (type === 'TOPUP' || type === 'BONUS') return ArrowUpwardRound
  return EventNoteRound
}

const getColor = (delta) => {
  return delta > 0 ? '#18a058' : '#d03050'
}

onMounted(() => load(false))
</script>

<template>
  <div class="ledger-page">
    <n-card :title="t('ledger')" class="ledger-card">
      <template #header-extra>
        <n-icon size="24" :component="FormatListBulletedRound" />
      </template>
      
      <n-list hoverable clickable>
        <n-list-item v-for="r in rows" :key="r.id">
          <template #prefix>
            <n-icon size="28" :component="getIcon(r.type)" :color="getColor(r.credit_delta)" />
          </template>
          <n-thing :title="r.type">
            <template #description>
              <n-space vertical size="small">
                <n-text depth="3">{{ r.created_at }}</n-text>
                <div v-if="r.metadata" class="metadata-box">
                  <n-text depth="3" class="metadata-text">
                    {{ JSON.stringify(r.metadata) }}
                  </n-text>
                </div>
              </n-space>
            </template>
            <template #extra>
              <n-space vertical align="end">
                <n-statistic :value="Math.abs(r.credit_delta)">
                  <template #prefix>
                    <span :style="{ color: getColor(r.credit_delta) }">
                      {{ r.credit_delta > 0 ? '+' : '-' }}
                    </span>
                  </template>
                  <template #suffix>Coins</template>
                </n-statistic>
                <n-text depth="3" v-if="r.idr_ref">
                  Rp {{ r.idr_ref.toLocaleString('id-ID') }}
                </n-text>
              </n-space>
            </template>
          </n-thing>
        </n-list-item>
        <n-empty v-if="rows.length === 0 && !loading" :description="t('noLedger')" />
      </n-list>

      <div class="load-more" v-if="nextCursor">
        <n-button :loading="loading" @click="load(true)" secondary block>
          {{ t('loadMore') }}
        </n-button>
      </div>
    </n-card>
  </div>
</template>

<style scoped>
.ledger-page {
  max-width: 800px;
  margin: 0 auto;
  padding: 12px;
}

.ledger-card {
  border-radius: 16px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.05);
}

.metadata-box {
  background: rgba(0, 0, 0, 0.03);
  padding: 4px 8px;
  border-radius: 4px;
  margin-top: 4px;
}

.metadata-text {
  font-family: monospace;
  font-size: 0.8rem;
}

.load-more {
  margin-top: 24px;
  text-align: center;
}
</style>
