<script setup>
import { onMounted, ref } from 'vue'
import { useScopedI18n } from '@/i18n/app'
import { getLedger } from '../../../api/billing'

const message = useMessage()
const { t } = useScopedI18n('views.user.wallet.Ledger')
const rows = ref([])
const nextCursor = ref('')

const load = async (append = false) => {
  try {
    const page = await getLedger({ limit: 20, cursor: append ? nextCursor.value : '' })
    const items = page.items || []
    rows.value = append ? [...rows.value, ...items] : items
    nextCursor.value = page.next_cursor || ''
  } catch (err) {
    message.error(err.message || t('loadLedgerFailed'))
  }
}

onMounted(() => load(false))
</script>

<template>
  <n-space vertical>
    <n-table striped>
      <thead>
        <tr>
          <th>{{ t('type') }}</th>
          <th>{{ t('delta') }}</th>
          <th>{{ t('idrRef') }}</th>
          <th>{{ t('metadata') }}</th>
          <th>{{ t('created') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.id">
          <td>{{ r.type }}</td>
          <td>{{ r.credit_delta }}</td>
          <td>{{ r.idr_ref ?? '-' }}</td>
          <td>{{ r.metadata ? JSON.stringify(r.metadata) : '-' }}</td>
          <td>{{ r.created_at }}</td>
        </tr>
      </tbody>
    </n-table>
    <n-button :disabled="!nextCursor" @click="load(true)">{{ t('loadMore') }}</n-button>
  </n-space>
</template>
