<script setup>
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useGlobalState } from '../../../store'
import { getWallet, getLedger } from '../../../api/billing'
import { getRouterPathWithLang } from '../../../utils'

const router = useRouter()
const { locale } = useI18n({ useScope: 'global' })
const message = useMessage()
const { wallet } = useGlobalState()
const ledger = ref([])

const refresh = async () => {
  try {
    wallet.value = await getWallet()
    const page = await getLedger({ limit: 10 })
    ledger.value = page.items || []
  } catch (err) {
    message.error(err.message || 'Failed to load wallet')
  }
}

onMounted(refresh)
</script>

<template>
  <n-space vertical>
    <n-card title="Wallet">
      <n-statistic label="Credit" :value="wallet.balance_credit || 0" />
      <div>IDR Ref: {{ wallet.balance_idr_ref || 0 }}</div>
      <div>Updated: {{ wallet.updated_at || '-' }}</div>
      <n-space style="margin-top: 12px">
        <n-button type="primary" @click="router.push(getRouterPathWithLang('/user/wallet/topup', locale))">Top-up</n-button>
        <n-button @click="router.push(getRouterPathWithLang('/user/wallet/ledger', locale))">Ledger</n-button>
        <n-button @click="router.push(getRouterPathWithLang('/user/wallet/topup/history', locale))">Top-up History</n-button>
      </n-space>
    </n-card>

    <n-card title="Latest Ledger (10)">
      <n-table striped>
        <thead>
          <tr>
            <th>Type</th>
            <th>Delta</th>
            <th>At</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in ledger" :key="row.id">
            <td>{{ row.type }}</td>
            <td>{{ row.credit_delta }}</td>
            <td>{{ row.created_at }}</td>
          </tr>
        </tbody>
      </n-table>
    </n-card>
  </n-space>
</template>
