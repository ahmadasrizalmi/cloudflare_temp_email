<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useMessage } from 'naive-ui'
import { useScopedI18n } from '@/i18n/app'
import { createTopup, quoteTopup, getTopupHistory, checkVoucherApi } from '../../../api/billing'
import { useGlobalState } from '../../../store'
import {
  PaymentsRound, 
  CheckCircleRound,
  InfoOutlined,
  AccountBalanceRound,
  QrCodeRound,
  AccountBalanceWalletRound,
  StorefrontRound
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
const voucherCode = ref('')
const discountAmount = ref(0)
const checkingVoucher = ref(false)
const isValidVoucher = ref(false)

const groupedChannels = computed(() => {
  const groups = {}
  for (const ch of channels.value) {
    const g = ch.group || 'Lainnya'
    if (!groups[g]) groups[g] = []
    groups[g].push(ch)
  }
  return groups
})

const getGroupIcon = (groupName) => {
  const gn = groupName.toLowerCase()
  if (gn.includes('virtual account')) return AccountBalanceRound
  if (gn.includes('qris')) return QrCodeRound
  if (gn.includes('retail')) return StorefrontRound
  return AccountBalanceWalletRound
}

const getChannelLogo = (code) => {
  const c = code.toUpperCase()
  // Bank VA
  if (c.includes('BCA')) return 'https://d2f3dnsqg0ebia.cloudfront.net/v3/assets/images/bank-logos/bca.svg'
  if (c.includes('BNI')) return 'https://d2f3dnsqg0ebia.cloudfront.net/v3/assets/images/bank-logos/bni.svg'
  if (c.includes('BRI')) return 'https://d2f3dnsqg0ebia.cloudfront.net/v3/assets/images/bank-logos/bri.svg'
  if (c.includes('MANDIRI')) return 'https://d2f3dnsqg0ebia.cloudfront.net/v3/assets/images/bank-logos/mandiri.svg'
  if (c.includes('PERMATA')) return 'https://d2f3dnsqg0ebia.cloudfront.net/v3/assets/images/bank-logos/permata.svg'
  if (c.includes('CIMB')) return 'https://d2f3dnsqg0ebia.cloudfront.net/v3/assets/images/bank-logos/cimb.svg'
  if (c.includes('BSI')) return 'https://d2f3dnsqg0ebia.cloudfront.net/v3/assets/images/bank-logos/bsi.svg' // might fallback
  
  // E-Wallet & Others (using standard CDN links for ID brands)
  if (c.includes('OVO')) return 'https://upload.wikimedia.org/wikipedia/commons/e/eb/Logo_ovo_purple.svg'
  if (c.includes('DANA')) return 'https://upload.wikimedia.org/wikipedia/commons/7/72/Logo_dana_blue.svg'
  if (c.includes('SHOPEEPAY')) return 'https://upload.wikimedia.org/wikipedia/commons/f/fe/ShopeePay_Logo.svg'
  if (c.includes('LINKAJA')) return 'https://upload.wikimedia.org/wikipedia/commons/8/85/LinkAja.svg'
  if (c.includes('GOPAY')) return 'https://upload.wikimedia.org/wikipedia/commons/8/86/Gopay_logo.svg'
  if (c.includes('QRIS')) return 'https://upload.wikimedia.org/wikipedia/commons/a/a2/Logo_QRIS.svg'
  if (c.includes('ALFAMART')) return 'https://upload.wikimedia.org/wikipedia/commons/9/9e/ALFAMART_LOGO_BARU.png'
  if (c.includes('INDOMARET')) return 'https://upload.wikimedia.org/wikipedia/commons/9/9d/Logo_Indomaret.png'
  
  return null
}

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

const handleCheckVoucher = async () => {
  if (!voucherCode.value) {
    message.warning('Masukkan kode voucher terlebih dahulu')
    return
  }
  checkingVoucher.value = true
  try {
    const res = await checkVoucherApi(voucherCode.value, Number(nominal.value))
    if (res.valid) {
      discountAmount.value = res.discountAmount
      isValidVoucher.value = true
      message.success(`Voucher valid! Diskon: Rp ${res.discountAmount.toLocaleString('id-ID')}`)
    } else {
      discountAmount.value = 0
      isValidVoucher.value = false
      message.error(res.message || 'Voucher tidak valid')
    }
  } catch (err) {
    discountAmount.value = 0
    isValidVoucher.value = false
    message.error(err.message || 'Gagal mengecek voucher')
  } finally {
    checkingVoucher.value = false
  }
}

watch(voucherCode, () => {
  discountAmount.value = 0
  isValidVoucher.value = false
})

const payNow = async () => {
  try {
    loading.value = true
    const res = await createTopup(Number(nominal.value), selected.value, voucherCode.value)
    if (res?.is_free) {
        message.success("Voucher berhasil digunakan! Saldo bertambah.")
        await refreshWallet()
        loading.value = false
        return
    }
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
          <n-tabs type="line" animated justify-content="space-evenly" style="margin-bottom: 16px;" v-if="channels.length > 0">
            <n-tab-pane v-for="(groupChannels, groupName) in groupedChannels" :key="groupName" :name="groupName">
              <template #tab>
                <n-space align="center" :size="4" :wrap="false">
                  <n-icon :component="getGroupIcon(groupName)" />
                  <span style="font-weight: 600;">{{ groupName }}</span>
                </n-space>
              </template>

              <n-radio-group v-model:value="selected" class="channel-group" style="width: 100%;">
                <n-grid :cols="2" :x-gap="12" :y-gap="12" responsive="screen" item-responsive>
                  <n-grid-item span="2 s:1 m:1" v-for="ch in groupChannels" :key="ch.channel_code">
                    <n-card 
                      hoverable 
                      class="channel-tile"
                      :class="{ 'selected': selected === ch.channel_code }"
                      @click="selected = ch.channel_code"
                      content-style="padding: 16px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; height: 100%; position: relative;"
                    >
                      <div class="channel-logo" :class="{ 'has-image': getChannelLogo(ch.channel_code) }">
                        <img v-if="getChannelLogo(ch.channel_code)" :src="getChannelLogo(ch.channel_code)" :alt="ch.name" class="channel-logo-img" />
                        <span v-else>{{ ch.name.substring(0, 2).toUpperCase() }}</span>
                      </div>
                      
                      <div class="channel-name-compact" style="font-weight: 600; font-size: 14px; margin-top: 12px; line-height: 1.2;">
                        {{ ch.name }}
                      </div>

                      <div v-if="ch.estimated_fee > 0" style="font-size: 12px; color: #999; margin-top: 6px;">
                        + Fee Rp {{ ch.estimated_fee.toLocaleString('id-ID') }}
                      </div>
                      <div v-else style="font-size: 12px; color: #18a058; margin-top: 6px; font-weight: 600;">
                        Gratis Fee
                      </div>

                      <div class="channel-gross-compact" style="font-weight: 700; color: #18a058; margin-top: 12px; font-size: 16px;">
                        <span v-if="discountAmount > 0" style="text-decoration: line-through; font-size: 11px; color: #999; display: block;">
                          Rp {{ ch.gross_amount.toLocaleString('id-ID') }}
                        </span>
                        Rp {{ Math.max(0, ch.gross_amount - discountAmount).toLocaleString('id-ID') }}
                      </div>

                      <n-radio :value="ch.channel_code" style="display: none;" />
                    </n-card>
                  </n-grid-item>
                </n-grid>
              </n-radio-group>
            </n-tab-pane>
          </n-tabs>
        </n-spin>

        <n-alert v-if="channels.length === 0 && !quoteLoading" type="info" :show-icon="false">
          <template #icon><n-icon :component="InfoOutlined" /></template>
          {{ t('noChannels') }}
        </n-alert>

        <div class="voucher-section" style="margin-top: 24px;">
          <n-form-item label="Kode Voucher (Opsional)">
            <n-input-group>
              <n-input v-model:value="voucherCode" placeholder="Masukkan kode voucher untuk diskon / gratis" clearable />
              <n-button type="primary" :loading="checkingVoucher" @click="handleCheckVoucher" ghost>
                Cek Voucher
              </n-button>
            </n-input-group>
          </n-form-item>
          <n-alert v-if="isValidVoucher" type="success" :show-icon="false" style="margin-top: -12px; margin-bottom: 24px;">
            <template #icon><n-icon :component="CheckCircleRound" /></template>
            Voucher diterapkan! Diskon Rp {{ discountAmount.toLocaleString('id-ID') }}
          </n-alert>
        </div>

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

.channel-tile {
  cursor: pointer;
  transition: all 0.2s ease-in-out;
  border-radius: 12px;
  border: 2px solid transparent;
}

.channel-tile.selected {
  border-color: #18a058;
  background-color: rgba(24, 160, 88, 0.05);
  box-shadow: 0 4px 12px rgba(24, 160, 88, 0.15);
  transform: translateY(-2px);
}

.channel-tile:hover:not(.selected) {
  border-color: rgba(24, 160, 88, 0.3);
  transform: translateY(-2px);
}

.channel-logo {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  background: linear-gradient(135deg, #f0f4f8, #d9e2ec);
  color: #334e68;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 800;
  font-size: 18px;
  box-shadow: inset 0 2px 4px rgba(255,255,255,0.8), 0 2px 4px rgba(0,0,0,0.05);
  letter-spacing: 1px;
  overflow: hidden;
}

.channel-logo.has-image {
  background: #ffffff;
  box-shadow: 0 2px 8px rgba(0,0,0,0.05);
  padding: 4px;
}

.channel-logo-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.dark-theme .channel-logo {
  background: linear-gradient(135deg, #2d3748, #1a202c);
  color: #e2e8f0;
  box-shadow: inset 0 2px 4px rgba(255,255,255,0.1), 0 2px 4px rgba(0,0,0,0.2);
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
