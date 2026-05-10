<script setup>
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useScopedI18n } from '@/i18n/app'
import { useGlobalState } from '../../../store'
import { getWallet, getLedger } from '../../../api/billing'
import { getRouterPathWithLang } from '../../../utils'

const router = useRouter()
const { locale } = useI18n({ useScope: 'global' })
const { t } = useScopedI18n('views.user.wallet.WalletHome')
const message = useMessage()
const { wallet } = useGlobalState()
const ledger = ref([])

const refresh = async () => {
  try {
    wallet.value = await getWallet()
    const page = await getLedger({ limit: 10 })
    ledger.value = page.items || []
  } catch (err) {
    message.error(err.message || t('loadWalletFailed'))
  }
}

onMounted(refresh)
</script>

<template>
  <n-space vertical>
    <n-card :title="t('wallet')">
      <n-statistic :label="t('credit')" :value="wallet.balance_credit || 0" />
      <div>{{ t('idrRef') }}: {{ wallet.balance_idr_ref || 0 }}</div>
      <div>{{ t('updated') }}: {{ wallet.updated_at || '-' }}</div>
      <n-space style="margin-top: 12px">
        <n-button type="primary" @click="router.push(getRouterPathWithLang('/user/wallet/topup', locale))">{{ t('topup') }}</n-button>
        <n-button @click="router.push(getRouterPathWithLang('/user/wallet/ledger', locale))">{{ t('ledger') }}</n-button>
        <n-button @click="router.push(getRouterPathWithLang('/user/wallet/topup/history', locale))">{{ t('topupHistory') }}</n-button>
      </n-space>
    </n-card>

    <n-card :title="t('latestLedger')">
      <n-table striped>
        <thead>
          <tr>
            <th>{{ t('type') }}</th>
            <th>{{ t('delta') }}</th>
            <th>{{ t('at') }}</th>
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
