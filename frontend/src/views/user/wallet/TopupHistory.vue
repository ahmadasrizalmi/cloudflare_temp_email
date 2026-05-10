<script setup>
import { onMounted, ref } from 'vue'
import { getTopupHistory } from '../../../api/billing'

const message = useMessage()
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
    message.error(err.message || 'Failed to load topup history')
  }
}

onMounted(() => load(false))
</script>

<template>
  <n-space vertical>
    <n-select
      v-model:value="status"
      :options="[
        { label: 'All', value: '' },
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
          <th>Invoice</th>
          <th>Amount</th>
          <th>Fee</th>
          <th>Gross</th>
          <th>Channel</th>
          <th>Status</th>
          <th>Created</th>
          <th>Paid</th>
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
    <n-button :disabled="!nextCursor" @click="load(true)">Load More</n-button>
  </n-space>
</template>

