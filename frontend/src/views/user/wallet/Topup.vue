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

  Object.keys(groups).forEach(k => {
    if (groups[k].length === 0) delete groups[k]
  })

  return groups
})

const tabOrder = ['QRIS', 'VA Bank', 'E-Wallet', 'Minimarket']

const sortedGroupNames = computed(() => {
  const keys = Object.keys(groupedChannels.value)
  return tabOrder.filter(k => keys.includes(k))
})

const getGroupIcon = (groupName) => {
  if (groupName === 'VA Bank') return AccountBalanceRound
  if (groupName === 'QRIS') return QrCodeRound
  if (groupName === 'Minimarket') return StorefrontRound
  return AccountBalanceWalletRound
}

const getChannelLogo = (code, name) => {
  const c = (code || '').toUpperCase()
  const n = (name || '').toUpperCase()
  // VA Banks
  if (c.includes('BCA') || n.includes('BCA')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5c/Bank_Central_Asia.svg/200px-Bank_Central_Asia.svg.png'
  if (c.includes('BNI') || n.includes('BNI')) return 'https://upload.wikimedia.org/wikipedia/id/thumb/5/55/BNI_logo.svg/200px-BNI_logo.svg.png'
  if (c.includes('BRI') || n.includes('BRI')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/68/BANK_BRI_logo.svg/200px-BANK_BRI_logo.svg.png'
  if (c.includes('MANDIRI') || n.includes('MANDIRI')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ad/Bank_Mandiri_logo_2016.svg/200px-Bank_Mandiri_logo_2016.svg.png'
  if (c.includes('PERMATA') || n.includes('PERMATA')) return 'https://upload.wikimedia.org/wikipedia/id/thumb/6/6b/PermataBank_logo.svg/200px-PermataBank_logo.svg.png'
  if (c.includes('CIMB') || n.includes('CIMB')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/97/Logo_CIMB_Niaga.svg/200px-Logo_CIMB_Niaga.svg.png'
  if (c.includes('BSI') || n.includes('BSI')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a0/Bank_Syariah_Indonesia.svg/200px-Bank_Syariah_Indonesia.svg.png'
  if (c.includes('DANAMON') || n.includes('DANAMON')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b8/Bank_Danamon_logo.svg/200px-Bank_Danamon_logo.svg.png'
  if (c.includes('BNC') || n.includes('BNC') || n.includes('NEO')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5d/Logo_Bank_Neo_Commerce.svg/200px-Logo_Bank_Neo_Commerce.svg.png'
  // E-Wallets
  if (c.includes('OVO') || n.includes('OVO')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/eb/Logo_ovo_purple.svg/200px-Logo_ovo_purple.svg.png'
  if (c.includes('DANA') || n.includes('DANA')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/72/Logo_dana_blue.svg/200px-Logo_dana_blue.svg.png'
  if (c.includes('SHOPEE') || n.includes('SHOPEE')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fe/ShopeePay_Logo.svg/200px-ShopeePay_Logo.svg.png'
  if (c.includes('LINKAJA') || n.includes('LINKAJA')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/85/LinkAja.svg/200px-LinkAja.svg.png'
  if (c.includes('GOPAY') || n.includes('GOPAY')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/86/Gopay_logo.svg/200px-Gopay_logo.svg.png'
  // QRIS
  if (c.includes('QRIS') || n.includes('QRIS')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a2/Logo_QRIS.svg/200px-Logo_QRIS.svg.png'
  // Retail
  if (c.includes('ALFAMART') || n.includes('ALFAMART')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9e/ALFAMART_LOGO_BARU.png/200px-ALFAMART_LOGO_BARU.png'
  if (c.includes('INDOMARET') || n.includes('INDOMARET')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9d/Logo_Indomaret.png/200px-Logo_Indomaret.png'

  return null
}

const logoError = ref({})
const onLogoError = (code) => {
  logoError.value[code] = true
}

const getShortName = (name) => {
  return name
    .replace(/VIRTUAL ACCOUNT /gi, '')
    .replace(/Virtual Account /gi, '')
}

const loadQuote = async () => {
  if (!nominal.value || nominal.value < 10000) return
  try {
    quoteLoading.value = true
    channels.value = await quoteTopup(Number(nominal.value))
    if (!selected.value && channels.value.length > 0) {
      const qrisChannel = channels.value.find(
        ch => ch.channel_code === 'QRIS' ||
              ch.name.toUpperCase().includes('QRIS') ||
              (ch.group && ch.group.toUpperCase() === 'QRIS')
      )
      if (qrisChannel) {
        selected.value = qrisChannel.channel_code
        activeTab.value = 'QRIS'
      } else {
        selected.value = channels.value[0].channel_code
        activeTab.value = sortedGroupNames.value[0] || ''
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
    if (!res?.checkout_url) {
      const responseStr = JSON.stringify(res, null, 2)
      message.error(`Gagal mendapatkan link pembayaran: ${responseStr}`)
      console.error('No checkout_url in response:', res)
      loading.value = false
      return
    }
    window.open(res.checkout_url, '_blank', 'noopener,noreferrer')
    message.info('Halaman pembayaran dibuka di tab baru. Menunggu konfirmasi...')

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
            <!-- Category Tabs -->
            <div class="cat-tabs">
              <div
                v-for="groupName in sortedGroupNames"
                :key="groupName"
                class="cat-tab"
                :class="{ active: activeTab === groupName }"
                @click="activeTab = groupName"
              >
                <n-icon :component="getGroupIcon(groupName)" :size="24" />
                <span>{{ groupName }}</span>
              </div>
            </div>

            <!-- Info text -->
            <div class="cat-info" v-if="activeTab">
              <template v-if="activeTab === 'QRIS'">⚡ QRIS — Metode paling cepat. Scan dari aplikasi banking / e-wallet manapun.</template>
              <template v-else-if="activeTab === 'VA Bank'">🏦 VA Bank — Transfer ke Virtual Account bank pilihan Anda via ATM / m-Banking.</template>
              <template v-else-if="activeTab === 'E-Wallet'">💳 E-Wallet — Bayar instan menggunakan dompet digital Anda.</template>
              <template v-else-if="activeTab === 'Minimarket'">🏪 Minimarket — Bayar tunai di kasir minimarket terdekat.</template>
            </div>

            <!-- Channel List -->
            <n-radio-group v-model:value="selected" style="width: 100%;">
              <div class="ch-list">
                <div
                  v-for="ch in groupedChannels[activeTab]"
                  :key="ch.channel_code"
                  class="ch-row"
                  :class="{ active: selected === ch.channel_code }"
                  @click="selected = ch.channel_code"
                >
                  <!-- Logo -->
                  <div class="ch-logo">
                    <img
                      v-if="getChannelLogo(ch.channel_code, ch.name) && !logoError[ch.channel_code]"
                      :src="getChannelLogo(ch.channel_code, ch.name)"
                      :alt="ch.name"
                      @error="onLogoError(ch.channel_code)"
                    />
                    <span v-else class="ch-logo-text">{{ ch.name.substring(0, 3).toUpperCase() }}</span>
                  </div>

                  <!-- Info -->
                  <div class="ch-info">
                    <div class="ch-name">{{ getShortName(ch.name) }}</div>
                    <div class="ch-desc">
                      <template v-if="activeTab === 'VA Bank'">Transfer via ATM / m-Banking</template>
                      <template v-else-if="activeTab === 'E-Wallet'">Bayar instan via aplikasi</template>
                      <template v-else-if="activeTab === 'QRIS'">Scan QR — semua bank & e-wallet</template>
                      <template v-else>Bayar tunai di kasir</template>
                      <span v-if="ch.estimated_fee > 0" class="ch-fee"> · +Rp {{ ch.estimated_fee.toLocaleString('id-ID') }}</span>
                      <span v-else class="ch-fee-free"> · Gratis Fee</span>
                    </div>
                  </div>

                  <!-- Check -->
                  <div class="ch-check">
                    <n-icon v-if="selected === ch.channel_code" size="22" :component="CheckCircleRound" color="#18a058" />
                    <div v-else class="ch-check-empty"></div>
                  </div>

                  <n-radio :value="ch.channel_code" style="display:none;" />
                </div>
              </div>
            </n-radio-group>
          </div>
        </n-spin>

        <n-alert v-if="channels.length === 0 && !quoteLoading" type="info" :show-icon="false">
          <template #icon><n-icon :component="InfoOutlined" /></template>
          {{ t('noChannels') }}
        </n-alert>

        <div style="margin-top: 24px;">
          <n-form-item label="Kode Voucher (Opsional)">
            <n-input-group>
              <n-input v-model:value="voucherCode" placeholder="Masukkan kode voucher" clearable />
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

/* ─── Category Tabs ─── */
.cat-tabs {
  display: flex;
  gap: 10px;
  margin-bottom: 12px;
  overflow-x: auto;
  -ms-overflow-style: none;
  scrollbar-width: none;
}
.cat-tabs::-webkit-scrollbar {
  display: none;
}
.cat-tab {
  flex: 1;
  min-width: 80px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 14px 8px;
  border-radius: 12px;
  border: 1px solid #e8e8e8;
  background: #fff;
  color: #666;
  cursor: pointer;
  transition: all 0.2s ease;
  font-size: 12px;
  font-weight: 600;
}
.cat-tab:hover {
  border-color: #c0c0c0;
}
.cat-tab.active {
  background: #f5f5f5;
  border-color: #333;
  color: #111;
}

/* ─── Info bar ─── */
.cat-info {
  background: #fafafa;
  border: 1px solid #eee;
  border-radius: 10px;
  padding: 12px 14px;
  font-size: 13px;
  color: #555;
  margin-bottom: 14px;
}

/* ─── Channel rows ─── */
.ch-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ch-row {
  display: flex;
  align-items: center;
  padding: 14px 16px;
  border: 1px solid #e8e8e8;
  border-radius: 12px;
  background: #fff;
  cursor: pointer;
  transition: all 0.15s ease;
}
.ch-row:hover {
  border-color: #bbb;
}
.ch-row.active {
  background: #f7f7f7;
  border-color: #18a058;
}

/* Logo */
.ch-logo {
  width: 48px;
  height: 48px;
  border-radius: 8px;
  border: 1px solid #eee;
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-right: 14px;
  flex-shrink: 0;
  overflow: hidden;
  padding: 4px;
}
.ch-logo img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.ch-logo-text {
  font-weight: 700;
  font-size: 13px;
  color: #999;
  letter-spacing: 0.5px;
}

/* Info */
.ch-info {
  flex: 1;
  min-width: 0;
}
.ch-name {
  font-size: 15px;
  font-weight: 700;
  color: #222;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ch-desc {
  font-size: 12px;
  color: #888;
  margin-top: 2px;
}
.ch-fee {
  color: #c48b00;
}
.ch-fee-free {
  color: #18a058;
  font-weight: 600;
}

/* Check mark */
.ch-check {
  margin-left: 12px;
  flex-shrink: 0;
}
.ch-check-empty {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid #ddd;
}
.ch-row:hover .ch-check-empty {
  border-color: #aaa;
}

/* Pay button */
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
