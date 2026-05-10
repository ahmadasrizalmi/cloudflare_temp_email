<script setup>
import { computed, onMounted, ref } from 'vue'
import { useScopedI18n } from '@/i18n/app'
import { createTopup, quoteTopup, getTopupHistory, getWallet } from '../../../api/billing'
import { useGlobalState } from '../../../store'

const message = useMessage()
const { t } = useScopedI18n('views.user.wallet.Topup')
const { wallet } = useGlobalState()

const presets = [10000, 20000, 50000, 100000, 250000]
const nominal = ref(10000)
const channels = ref([])
const selected = ref('')
const loading = ref(false)

const loadQuote = async () => {
  try {
    channels.value = await quoteTopup(Number(nominal.value))
    if (!selected.value && channels.value.length > 0) {
      selected.value = channels.value[0].channel_code
    }
  } catch (err) {
    channels.value = []
    message.error(err.message || t('quoteFailed'))
  }
}

const payNow = async () => {
  try {
    loading.value = true
    const res = await createTopup(Number(nominal.value), selected.value)
    if (res?.checkout_url) window.open(res.checkout_url, '_blank', 'noopener,noreferrer')
    const start = Date.now()
    while (Date.now() - start < 120000) {
      const history = await getTopupHistory({ limit: 20 })
      const invoice = (history.items || []).find((x) => x.invoice_id === res.invoice_id)
      if (invoice && invoice.status !== 'pending') break
      await new Promise((r) => setTimeout(r, 5000))
    }
    wallet.value = await getWallet()
    message.success(t('topupUpdated'))
  } catch (err) {
    message.error(err.message || t('createTopupFailed'))
  } finally {
    loading.value = false
  }
}

const canPay = computed(() => Number(nominal.value) >= 10000 && !!selected.value)

onMounted(loadQuote)
</script>

<template>
  <n-space vertical>
    <n-card :title="t('topup')">
      <n-space>
        <n-button v-for="p in presets" :key="p" @click="nominal = p; loadQuote()">
          Rp{{ p.toLocaleString('id-ID') }}
        </n-button>
      </n-space>
      <n-input-number v-model:value="nominal" :min="10000" style="margin-top: 12px" @update:value="loadQuote" />
    </n-card>

    <n-card :title="t('channels')">
      <n-radio-group v-model:value="selected">
        <n-space vertical>
          <n-radio v-for="ch in channels" :key="ch.channel_code" :value="ch.channel_code">
            {{ ch.name }} | {{ t('fee') }}: {{ ch.estimated_fee }} | {{ t('gross') }}: {{ ch.gross_amount }} | {{ ch.fee_bearer }}
          </n-radio>
        </n-space>
      </n-radio-group>
      <n-button type="primary" :disabled="!canPay" :loading="loading" style="margin-top: 12px" @click="payNow">
        {{ t('payNow') }}
      </n-button>
    </n-card>
  </n-space>
</template>
