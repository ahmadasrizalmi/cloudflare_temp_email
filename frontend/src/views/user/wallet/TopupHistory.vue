<script setup>
import { onMounted, ref } from 'vue'
import { useScopedI18n } from '@/i18n/app'
import { getTopupHistory } from '../../../api/billing'

const message = useMessage()
const { t } = useScopedI18n('views.user.wallet.TopupHistory')
const rows = ref([])
const nextCursor = ref('')
const status = ref('')

const load = async (append = false) => {
  try {
    const page = await getTopupHistory({ limit: 20, cursor: append ? nextCursor.value : '', status: status.value })
    const items = page.items || []
    rows.value = append ? [...rows.value, ...items] : items
    nextCursor.value = page.next_cursor || ''
  } catch (err) {
    message.error(err.message || t('loadTopupHistoryFailed'))
  }
}

onMounted(() => load(false))
</script>

<template>
  <n-space vertical>
    <n-select
      v-model:value="status"
      :options="[
        { label: t('all'), value: '' },
        { label: 'pending', value: 'pending' },
        { label: 'paid', value: 'paid' },
        { label: 'failed', value: 'failed' },
        { label: 'expired', value: 'expired' },
        { label: 'cancelled', value: 'cancelled' }
      ]"
      @update:value="load(false)"
    />
    <n-table striped>
      <thead>
        <tr>
          <th>{{ t('invoice') }}</th>
          <th>{{ t('amount') }}</th>
          <th>{{ t('fee') }}</th>
          <th>{{ t('gross') }}</th>
          <th>{{ t('channel') }}</th>
          <th>{{ t('status') }}</th>
          <th>{{ t('created') }}</th>
          <th>{{ t('paid') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.id">
          <td>{{ r.invoice_id }}</td>
          <td>{{ r.amount }}</td>
          <td>{{ r.fee }}</td>
          <td>{{ r.gross_amount }}</td>
          <td>{{ r.channel_code }}</td>
          <td>{{ r.status }}</td>
          <td>{{ r.created_at }}</td>
          <td>{{ r.paid_at || '-' }}</td>
        </tr>
      </tbody>
    </n-table>
    <n-button :disabled="!nextCursor" @click="load(true)">{{ t('loadMore') }}</n-button>
  </n-space>
</template>
