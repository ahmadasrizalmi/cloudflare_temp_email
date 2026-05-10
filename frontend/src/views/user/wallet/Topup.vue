<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useMessage } from 'naive-ui'
import { useScopedI18n } from '@/i18n/app'
import { createTopup, quoteTopup, getTopupHistory } from '../../../api/billing'
import { useGlobalState } from '../../../store'
import { 
  PaymentsRound, 
  CheckCircleRound,
  InfoOutlined
} from '@vicons/material'

const message = useMessage()
const { t } = useScopedI18n('views.user.wallet.Topup')
const { refreshWallet } = useGlobalState()

const presets = [10000, 20000, 50000, 100000, 250000]
const nominal = ref(10000)
const channels = ref([])
const selected = ref('')
const loading = ref(false)
const quoteLoading = ref(false)

const loadQuote = async () => {
  if (!nominal.value || nominal.value < 10000) return
  try {
    quoteLoading.value = true
    channels.value = await quoteTopup(Number(nominal.value))
    if (!selected.value && channels.value.length > 0) {
      selected.value = channels.value[0].channel_code
    }
  } catch (err) {
    channels.value = []
    message.error(err.message || t('quoteFailed'))
  } finally {
    quoteLoading.value = false
  }
}

const payNow = async () => {
  try {
    loading.value = true
    const res = await createTopup(Number(nominal.value), selected.value)
    if (res?.checkout_url) window.open(res.checkout_url, '_blank', 'noopener,noreferrer')
    
    // Polling for status update
    const start = Date.now()
    let success = false
    while (Date.now() - start < 120000) {
      const history = await getTopupHistory({ limit: 10 })
      const invoice = (history.items || []).find((x) => x.invoice_id === res.invoice_id)
      if (invoice && invoice.status === 'paid') {
        success = true
        break
      }
      if (invoice && (invoice.status === 'failed' || invoice.status === 'expired')) break
      await new Promise((r) => setTimeout(r, 5000))
    }
    
    await refreshWallet()
    if (success) {
      message.success(t('topupUpdated'))
    }
  } catch (err) {
    message.error(err.message || t('createTopupFailed'))
  } finally {
    loading.value = false
  }
}

const canPay = computed(() => Number(nominal.value) >= 10000 && !!selected.value)

onMounted(loadQuote)
watch(nominal, loadQuote)
</script>

<template>
  <div class="topup-page">
    <n-space vertical size="large">
      <!-- Nominal Selection -->
      <n-card class="topup-card" :title="t('topup')">
        <template #header-extra>
          <n-icon size="24" :component="PaymentsRound" color="#18a058" />
        </template>
        
        <n-space vertical size="large">
          <n-grid :cols="2" :x-gap="12" :y-gap="12">
            <n-gi v-for="p in presets" :key="p">
              <n-button 
                block 
                :type="nominal === p ? 'primary' : 'default'" 
                :tertiary="nominal !== p"
                @click="nominal = p"
                class="preset-btn"
              >
                <div class="preset-content">
                  <span class="preset-label">Rp {{ p.toLocaleString('id-ID') }}</span>
                  <n-badge v-if="p >= 100000" type="success" :value="'Bonus'" />
                </div>
              </n-button>
            </n-gi>
          </n-grid>

          <n-form-item :label="t('customNominal')" :feedback="nominal < 10000 ? 'Min Rp 10.000' : ''" :validation-status="nominal < 10000 ? 'error' : ''">
            <n-input-number 
              v-model:value="nominal" 
              :min="10000" 
              :step="5000"
              class="nominal-input"
              style="width: 100%"
            >
              <template #prefix>Rp</template>
            </n-input-number>
          </n-form-item>
        </n-space>
      </n-card>

      <!-- Channel Selection -->
      <n-card class="topup-card" :title="t('channels')">
        <template #header-extra>
          <n-icon size="24" :component="CheckCircleRound" color="#2080f0" />
        </template>
        
        <n-spin :show="quoteLoading">
          <n-radio-group v-model:value="selected" class="channel-group">
            <n-space vertical size="medium">
              <n-card 
                v-for="ch in channels" 
                :key="ch.channel_code" 
                hoverable 
                size="small" 
                class="channel-item"
                :class="{ 'selected': selected === ch.channel_code }"
                @click="selected = ch.channel_code"
              >
                <n-space align="center" justify="space-between" :wrap="false">
                  <n-space align="center" :wrap="false">
                    <n-radio :value="ch.channel_code" />
                    <div class="channel-info">
                      <div class="channel-name">{{ ch.name }}</div>
                      <div class="channel-fee">
                        <n-text depth="3">{{ t('fee') }}: </n-text>
                        <n-text type="warning">Rp {{ ch.estimated_fee.toLocaleString('id-ID') }}</n-text>
                      </div>
                    </div>
                  </n-space>
                  <div class="channel-gross">
                    <n-text strong>Rp {{ ch.gross_amount.toLocaleString('id-ID') }}</n-text>
                  </div>
                </n-space>
              </n-card>
            </n-space>
          </n-radio-group>
        </n-spin>

        <n-alert v-if="channels.length === 0 && !quoteLoading" type="info" :show-icon="false">
          <template #icon><n-icon :component="InfoOutlined" /></template>
          {{ t('noChannels') }}
        </n-alert>

        <div class="pay-action">
          <n-button 
            type="primary" 
            size="large" 
            block 
            :disabled="!canPay" 
            :loading="loading"
            class="pay-btn"
            @click="payNow"
          >
            {{ t('payNow') }}
          </n-button>
          <n-text depth="3" class="pay-tip">
            {{ t('payTip') }}
          </n-text>
        </div>
      </n-card>
    </n-space>
  </div>
</template>

<style scoped>
.topup-page {
  max-width: 600px;
  margin: 0 auto;
  padding: 12px;
}

.topup-card {
  border-radius: 16px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.05);
}

.preset-btn {
  height: 60px;
  border-radius: 12px;
  transition: all 0.3s ease;
}

.preset-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.preset-label {
  font-weight: 600;
  font-size: 1rem;
}

.nominal-input {
  border-radius: 12px;
}

.channel-group {
  width: 100%;
}

.channel-item {
  border-radius: 12px;
  transition: all 0.2s ease;
  cursor: pointer;
  border: 1px solid var(--n-border-color);
}

.channel-item.selected {
  border-color: var(--n-primary-color);
  background: rgba(24, 160, 88, 0.05);
}

.channel-info {
  display: flex;
  flex-direction: column;
}

.channel-name {
  font-weight: 600;
}

.channel-fee {
  font-size: 0.85rem;
}

.pay-action {
  margin-top: 24px;
  text-align: center;
}

.pay-btn {
  height: 54px;
  border-radius: 12px;
  font-weight: 700;
  font-size: 1.1rem;
}

.pay-tip {
  display: block;
  margin-top: 12px;
  font-size: 0.85rem;
}
</style>
