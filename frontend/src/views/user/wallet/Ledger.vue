<script setup>
import { onMounted, ref } from 'vue'
import { getLedger } from '../../../api/billing'

const message = useMessage()
const rows = ref([])
const nextCursor = ref('')

const load = async (append = false) => {
  try {
    const page = await getLedger({ limit: 20, cursor: append ? nextCursor.value : '' })
    const items = page.items || []
    rows.value = append ? [...rows.value, ...items] : items
    nextCursor.value = page.next_cursor || ''
  } catch (err) {
    message.error(err.message || 'Failed to load ledger')
  }
}

onMounted(() => load(false))
</script>

<template>
  <n-space vertical>
    <n-table striped>
      <thead>
        <tr>
          <th>Type</th>
          <th>Delta</th>
          <th>IDR Ref</th>
          <th>Metadata</th>
          <th>Created</th>
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
    <n-button :disabled="!nextCursor" @click="load(true)">Load More</n-button>
  </n-space>
</template>

