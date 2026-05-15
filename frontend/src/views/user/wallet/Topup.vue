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
const activeTab = ref('')

const groupedChannels = computed(() => {
  const groups = {
    'QRIS': [],
    'VA Bank': [],
    'E-Wallet': [],
    'Minimarket': []
  }
  
  for (const ch of channels.value) {
    const c = ch.channel_code.toUpperCase()
    const g = ch.group ? ch.group.toUpperCase() : ''
    
    if (c.includes('QRIS') || g.includes('QRIS')) {
      groups['QRIS'].push(ch)
    } else if (c.includes('VA') || g.includes('VIRTUAL ACCOUNT') || g.includes('BANK')) {
      groups['VA Bank'].push(ch)
    } else if (c.includes('ALFAMART') || c.includes('INDOMARET') || g.includes('RETAIL')) {
      groups['Minimarket'].push(ch)
    } else {
      groups['E-Wallet'].push(ch)
    }
  }
  
  // Remove empty groups
  Object.keys(groups).forEach(k => {
    if (groups[k].length === 0) delete groups[k]
  })
  
  return groups
})

const getGroupIcon = (groupName) => {
  const gn = groupName.toLowerCase()
  if (gn.includes('va bank')) return AccountBalanceRound
  if (gn.includes('qris')) return QrCodeRound
  if (gn.includes('minimarket')) return StorefrontRound
  return AccountBalanceWalletRound
}

const getChannelLogo = (code) => {
  const c = code.toUpperCase()
  if (c.includes('BCA')) return 'https://tripay.co.id/images/payment-channel/BCAVA.png'
  if (c.includes('BNI')) return 'https://tripay.co.id/images/payment-channel/BNIVA.png'
  if (c.includes('BRI')) return 'https://tripay.co.id/images/payment-channel/BRIVA.png'
  if (c.includes('MANDIRI')) return 'https://tripay.co.id/images/payment-channel/MANDIRIVA.png'
  if (c.includes('PERMATA')) return 'https://tripay.co.id/images/payment-channel/PERMATAVA.png'
  if (c.includes('CIMB')) return 'https://tripay.co.id/images/payment-channel/CIMBVA.png'
  if (c.includes('BSI')) return 'https://tripay.co.id/images/payment-channel/BSIVA.png'
  if (c.includes('DANAMON')) return 'https://tripay.co.id/images/payment-channel/DANAMONVA.png'
  if (c.includes('BNC')) return 'https://tripay.co.id/images/payment-channel/BNCVA.png'
  
  if (c.includes('OVO')) return 'https://tripay.co.id/images/payment-channel/OVO.png'
  if (c.includes('DANA')) return 'https://tripay.co.id/images/payment-channel/DANA.png'
  if (c.includes('SHOPEEPAY')) return 'https://tripay.co.id/images/payment-channel/SHOPEEPAY.png'
  if (c.includes('LINKAJA')) return 'https://tripay.co.id/images/payment-channel/LINKAJA.png'
  if (c.includes('QRIS')) return 'https://tripay.co.id/images/payment-channel/QRIS.png'
  if (c.includes('ALFAMART')) return 'https://tripay.co.id/images/payment-channel/ALFAMART.png'
  if (c.includes('INDOMARET')) return 'https://tripay.co.id/images/payment-channel/INDOMARET.png'
  
  return null
}

const loadQuote = async () => {
  if (!nominal.value || nominal.value < 10000) return
  try {
    quoteLoading.value = true
    channels.value = await quoteTopup(Number(nominal.value))
    if (!selected.value && channels.value.length > 0) {
      const qrisChannel = channels.value.find(ch => ch.channel_code === 'QRIS' || ch.name.toUpperCase().includes('QRIS') || (ch.group && ch.group.toUpperCase() === 'QRIS'));
      if (qrisChannel) {
        selected.value = qrisChannel.channel_code;
        selected.value = qrisChannel.channel_code;
        activeTab.value = 'QRIS';
      } else {
        selected.value = channels.value[0].channel_code;
        activeTab.value = Object.keys(groupedChannels.value)[0] || 'Lainnya';
      }
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
          <div v-if="channels.length > 0">
            <!-- Custom Tabs -->
            <div class="custom-tabs-container">
              <div 
                v-for="(groupChannels, groupName) in groupedChannels" 
                :key="groupName"
                class="custom-tab"
                :class="{ 'active': activeTab === groupName }"
                @click="activeTab = groupName"
              >
                <n-icon :component="getGroupIcon(groupName)" size="28" class="custom-tab-icon" />
                <span class="custom-tab-name">{{ groupName }}</span>
              </div>
            </div>

            <!-- Tab Info Alert -->
            <div class="custom-tab-alert" v-if="activeTab">
              <span v-if="activeTab === 'QRIS'">⚡ QRIS — Metode paling cepat. Scan dari aplikasi banking / e-wallet manapun.</span>
              <span v-else-if="activeTab === 'VA Bank'">🏦 VA Bank — Transfer ke Virtual Account bank pilihan Anda via ATM / m-Banking.</span>
              <span v-else-if="activeTab === 'E-Wallet'">💳 E-Wallet — Bayar instan menggunakan dompet digital Anda.</span>
              <span v-else-if="activeTab === 'Minimarket'">🏪 Minimarket — Bayar tunai di kasir minimarket terdekat.</span>
              <span v-else>💳 {{ activeTab }} — Pembayaran instan dan mudah.</span>
            </div>

            <!-- Vertical Channel List -->
            <n-radio-group v-model:value="selected" style="width: 100%;">
              <div class="channel-list">
                <div 
                  v-for="ch in groupedChannels[activeTab]" 
                  :key="ch.channel_code"
                  class="channel-row"
                  :class="{ 'selected': selected === ch.channel_code }"
                  @click="selected = ch.channel_code"
                >
                  <div class="channel-logo-container" :class="{ 'has-image': getChannelLogo(ch.channel_code) }">
                    <img v-if="getChannelLogo(ch.channel_code)" :src="getChannelLogo(ch.channel_code)" :alt="ch.name" class="channel-logo-img" @error="(e) => { e.target.style.display = 'none'; e.target.nextElementSibling.style.display = 'flex'; }" />
                    <span class="channel-logo-fallback" :style="{ display: getChannelLogo(ch.channel_code) ? 'none' : 'flex' }">{{ ch.name.substring(0, 2).toUpperCase() }}</span>
                  </div>
                  
                  <div class="channel-info-col">
                    <div class="channel-title">{{ ch.name.replace('VIRTUAL ACCOUNT ', '').replace('Virtual Account ', '') }}</div>
                    <div class="channel-subtitle">
                      <span v-if="activeTab === 'VA Bank'">Transfer via ATM / m-Banking {{ ch.name.replace('VIRTUAL ACCOUNT ', '') }}</span>
                      <span v-else-if="activeTab === 'E-Wallet'">Bayar instan via aplikasi {{ ch.name }}</span>
                      <span v-else-if="activeTab === 'QRIS'">Scan QR code via aplikasi apapun</span>
                      <span v-else>Bayar tunai di kasir {{ ch.name }}</span>
                      
                      <span v-if="ch.estimated_fee > 0" class="fee-text"> • +Rp {{ ch.estimated_fee.toLocaleString('id-ID') }}</span>
                      <span v-else class="fee-free"> • Gratis Fee</span>
                    </div>
                  </div>

                  <div class="channel-radio">
                    <n-icon size="24" :component="CheckCircleRound" v-if="selected === ch.channel_code" />
                    <div v-else class="channel-radio-empty"></div>
                  </div>
                  
                  <!-- Hidden radio for form semantics -->
                  <n-radio :value="ch.channel_code" style="display: none;" />
                </div>
              </div>
            </n-radio-group>
          </div>
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

.custom-tabs-container {
  display: flex;
  gap: 12px;
  overflow-x: auto;
  padding-bottom: 8px;
  margin-bottom: 4px;
}
.custom-tabs-container::-webkit-scrollbar {
  display: none;
}
.custom-tab {
  flex: 1;
  min-width: 90px;
  border-radius: 12px;
  background-color: var(--n-color-embedded);
  border: 1px solid var(--n-border-color);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 16px 8px;
  cursor: pointer;
  transition: all 0.3s ease;
  color: var(--n-text-color);
}
.custom-tab.active {
  background-color: var(--n-primary-color);
  color: #fff;
  border-color: var(--n-primary-color);
  box-shadow: 0 4px 12px rgba(24, 160, 88, 0.3);
}
.custom-tab-icon {
  margin-bottom: 8px;
}
.custom-tab-name {
  font-size: 13px;
  font-weight: 600;
  text-align: center;
}
.custom-tab-alert {
  background-color: rgba(24, 160, 88, 0.05);
  border: 1px solid rgba(24, 160, 88, 0.2);
  border-radius: 12px;
  padding: 14px 16px;
  font-size: 13px;
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  font-weight: 500;
  color: var(--n-text-color);
}

.channel-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.channel-row {
  display: flex;
  align-items: center;
  padding: 16px;
  border: 1px solid var(--n-border-color);
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
  background-color: var(--n-color);
}
.channel-row:hover:not(.selected) {
  border-color: rgba(24, 160, 88, 0.4);
}
.channel-row.selected {
  border-color: var(--n-primary-color);
  background-color: rgba(24, 160, 88, 0.05);
  box-shadow: 0 2px 8px rgba(24, 160, 88, 0.1);
}

.channel-logo-container {
  width: 52px;
  height: 52px;
  border-radius: 10px;
  background: linear-gradient(135deg, #f0f4f8, #d9e2ec);
  color: #334e68;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-right: 16px;
  flex-shrink: 0;
  overflow: hidden;
  border: 1px solid #eaeaea;
}
.channel-logo-container.has-image {
  background: #ffffff;
  padding: 4px;
}
.dark-theme .channel-logo-container {
  background: linear-gradient(135deg, #2d3748, #1a202c);
  border-color: #4a5568;
  color: #e2e8f0;
}
.dark-theme .channel-logo-container.has-image {
  background: #ffffff;
}
.channel-logo-img {
  max-width: 90%;
  max-height: 90%;
  object-fit: contain;
}
.channel-logo-fallback {
  font-weight: 800;
  font-size: 16px;
  letter-spacing: 1px;
}

.channel-info-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.channel-title {
  font-size: 15px;
  font-weight: 700;
  margin-bottom: 2px;
}
.channel-subtitle {
  font-size: 12px;
  color: #777;
}
.dark-theme .channel-subtitle {
  color: #aaa;
}
.fee-free {
  color: var(--n-primary-color);
  font-weight: 600;
}
.fee-text {
  color: #f2a900;
  font-weight: 500;
}

.channel-radio {
  margin-left: 12px;
  color: var(--n-primary-color);
  display: flex;
  align-items: center;
}
.channel-radio-empty {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 2px solid var(--n-border-color);
  transition: all 0.2s;
}
.channel-row:hover:not(.selected) .channel-radio-empty {
  border-color: rgba(24, 160, 88, 0.4);
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
