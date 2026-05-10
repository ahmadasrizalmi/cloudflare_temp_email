<script setup>
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useScopedI18n } from '@/i18n/app'
import { useMessage } from 'naive-ui'
import { useGlobalState } from '../../../store'
import { getRouterPathWithLang } from '../../../utils'
import { 
  AccountBalanceWalletRound, 
  AddCircleRound, 
  FormatListBulletedRound, 
  HistoryRound,
  RefreshRound,
  ChevronRightRound
} from '@vicons/material'

const router = useRouter()
const { locale } = useI18n({ useScope: 'global' })
const { t } = useScopedI18n('views.user.wallet.WalletHome')
const message = useMessage()
const { wallet, refreshWallet, loading } = useGlobalState()
const ledger = ref([])

const refresh = async () => {
  try {
    await refreshWallet()
    const { getLedger } = await import('../../../api/billing');
    const page = await getLedger({ limit: 5 })
    ledger.value = page.items || []
  } catch (err) {
    message.error(err.message || t('loadWalletFailed'))
  }
}

onMounted(refresh)
</script>

<template>
  <div class="wallet-home">
    <n-space vertical size="large">
      <!-- Premium Balance Card -->
      <n-card class="balance-card" :bordered="false">
        <template #header>
          <n-space align="center">
            <n-icon size="24" :component="AccountBalanceWalletRound" />
            <span class="card-title">{{ t('wallet') }}</span>
          </n-space>
        </template>
        <template #header-extra>
          <n-button quaternary circle @click="refresh" :loading="loading">
            <template #icon><n-icon :component="RefreshRound" /></template>
          </n-button>
        </template>
        
        <div class="balance-content">
          <n-statistic :label="t('credit')" :value="wallet.balance_credit || 0">
            <template #prefix>
              <n-icon :component="AddCircleRound" color="#18a058" />
            </template>
            <template #suffix>
              <span class="currency-suffix">Coins</span>
            </template>
          </n-statistic>
          
          <div class="balance-details">
            <n-text depth="3">
              {{ t('idrRef') }}: <span class="idr-value">Rp {{ (wallet.balance_idr_ref || 0).toLocaleString('id-ID') }}</span>
            </n-text>
            <n-text depth="3" class="update-time">
              {{ t('updated') }}: {{ wallet.updated_at || '-' }}
            </n-text>
          </div>
        </div>

        <div class="action-grid">
          <n-button 
            type="primary" 
            size="large" 
            block 
            class="action-btn"
            @click="router.push(getRouterPathWithLang('/user/wallet/topup', locale))"
          >
            <template #icon><n-icon :component="AddCircleRound" /></template>
            {{ t('topup') }}
          </n-button>
        </div>
      </n-card>

      <!-- Quick Actions -->
      <n-grid :cols="2" :x-gap="12">
        <n-gi>
          <n-card 
            hoverable 
            class="nav-card" 
            @click="router.push(getRouterPathWithLang('/user/wallet/ledger', locale))"
          >
            <n-space vertical align="center" size="small">
              <n-icon size="32" :component="FormatListBulletedRound" color="#2080f0" />
              <n-text strong>{{ t('ledger') }}</n-text>
            </n-space>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card 
            hoverable 
            class="nav-card" 
            @click="router.push(getRouterPathWithLang('/user/wallet/topup/history', locale))"
          >
            <n-space vertical align="center" size="small">
              <n-icon size="32" :component="HistoryRound" color="#f0a020" />
              <n-text strong>{{ t('topupHistory') }}</n-text>
            </n-space>
          </n-card>
        </n-gi>
      </n-grid>

      <!-- Recent Activity -->
      <n-card :title="t('latestLedger')" :segmented="{ content: true }">
        <template #header-extra>
          <n-button text type="primary" @click="router.push(getRouterPathWithLang('/user/wallet/ledger', locale))">
            {{ t('viewAll') }}
            <template #icon><n-icon :component="ChevronRightRound" /></template>
          </n-button>
        </template>
        <n-list hoverable clickable>
          <n-list-item v-for="row in ledger" :key="row.id">
            <n-thing :title="row.type">
              <template #description>
                <n-text depth="3">{{ row.created_at }}</n-text>
              </template>
              <template #extra>
                <n-statistic :value="Math.abs(row.credit_delta)" size="small">
                  <template #prefix>
                    <span :style="{ color: row.credit_delta > 0 ? '#18a058' : '#d03050' }">
                      {{ row.credit_delta > 0 ? '+' : '-' }}
                    </span>
                  </template>
                </n-statistic>
              </template>
            </n-thing>
          </n-list-item>
          <n-empty v-if="ledger.length === 0" :description="t('noActivity')" />
        </n-list>
      </n-card>
    </n-space>
  </div>
</template>

<style scoped>
.balance-card {
  background: linear-gradient(135deg, rgba(24, 160, 88, 0.1) 0%, rgba(32, 128, 240, 0.1) 100%);
  border-radius: 20px;
  overflow: hidden;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.05);
}

.card-title {
  font-weight: 700;
  font-size: 1.1rem;
}

.balance-content {
  padding: 12px 0;
  text-align: center;
}

.currency-suffix {
  font-size: 0.9rem;
  margin-left: 4px;
  opacity: 0.6;
}

.balance-details {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.idr-value {
  font-weight: 600;
  color: var(--n-text-color);
}

.update-time {
  font-size: 0.8rem;
}

.action-grid {
  margin-top: 24px;
}

.action-btn {
  border-radius: 12px;
  font-weight: 600;
  height: 48px;
}

.nav-card {
  cursor: pointer;
  border-radius: 16px;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.nav-card:hover {
  transform: translateY(-4px);
  background: rgba(var(--n-color), 0.8);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.wallet-home {
  max-width: 800px;
  margin: 0 auto;
  padding: 12px;
}
</style>
