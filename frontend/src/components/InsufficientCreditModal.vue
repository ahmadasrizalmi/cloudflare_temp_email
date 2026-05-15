<script setup>
/**
 * InsufficientCreditModal.vue
 * Shows a friendly "you've run out of credits" dialog with a CTA to topup.
 * Usage: <InsufficientCreditModal v-model:show="showModal" />
 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useGlobalState } from '../../store'
import { getRouterPathWithLang } from '../../utils'
import {
  AccountBalanceWalletOutlined,
  AddCircleOutlined,
  CloseRounded,
  ShoppingCartOutlined
} from '@vicons/material'

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  },
  freeUsed: {
    type: Number,
    default: 1
  },
  freeLimit: {
    type: Number,
    default: 1
  }
})

const emit = defineEmits(['update:show'])

const router = useRouter()
const { locale } = useI18n({ useScope: 'global' })
const { wallet } = useGlobalState()

const close = () => emit('update:show', false)

const goTopup = () => {
  close()
  router.push(getRouterPathWithLang('/user/wallet/topup', locale.value))
}

const goWallet = () => {
  close()
  router.push(getRouterPathWithLang('/user/wallet', locale.value))
}

const currentBalance = computed(() => wallet.value.balance_credit || 0)
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    class="insufficient-credit-modal"
    :style="{ maxWidth: '420px', borderRadius: '20px' }"
    :closable="true"
    :mask-closable="true"
    @update:show="(v) => emit('update:show', v)"
  >
    <template #header>
      <div class="modal-header">
        <div class="modal-icon-wrapper">
          <n-icon size="36" :component="AccountBalanceWalletOutlined" class="wallet-icon" />
        </div>
      </div>
    </template>

    <div class="modal-body">
      <div class="quota-info">
        <div class="quota-badge used">
          <span class="quota-num">{{ freeUsed }}</span>
          <span class="quota-text">/ {{ freeLimit }} email gratis</span>
        </div>
        <div class="progress-bar-wrapper">
          <div class="progress-bar" :style="{ width: '100%' }" />
        </div>
        <p class="quota-desc">Kamu sudah menggunakan semua email gratis.</p>
      </div>

      <div class="credit-status">
        <n-icon :component="AccountBalanceWalletOutlined" size="16" />
        <span>Saldo saat ini: <strong>{{ currentBalance }} Coins</strong></span>
        <n-tag v-if="currentBalance === 0" type="error" size="small" round>Kosong</n-tag>
        <n-tag v-else type="warning" size="small" round>Tidak cukup</n-tag>
      </div>

      <div class="benefit-list">
        <div class="benefit-item">
          <n-icon :component="AddCircleOutlined" color="#18a058" size="16" />
          <span>Beli kredit → buat email tak terbatas</span>
        </div>
        <div class="benefit-item">
          <n-icon :component="AddCircleOutlined" color="#18a058" size="16" />
          <span>Min. top up Rp 10.000 (100 Coins)</span>
        </div>
        <div class="benefit-item">
          <n-icon :component="AddCircleOutlined" color="#18a058" size="16" />
          <span>Bonus 5% untuk top up ≥ Rp 100.000</span>
        </div>
      </div>
    </div>

    <template #footer>
      <n-space justify="end" class="modal-footer">
        <n-button secondary @click="close">
          <template #icon><n-icon :component="CloseRounded" /></template>
          Nanti Saja
        </n-button>
        <n-button type="primary" @click="goTopup" class="topup-cta-btn">
          <template #icon><n-icon :component="ShoppingCartOutlined" /></template>
          Beli Kredit Sekarang
        </n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
.modal-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 8px;
  text-align: center;
}

.modal-icon-wrapper {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  background: linear-gradient(135deg, #ff6b6b22, #ffa50022);
  border: 2px solid #ffa50044;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 8px;
}

.wallet-icon {
  color: #f0a020;
}

.modal-title {
  font-size: 1.25rem;
  font-weight: 700;
  margin: 0;
  color: var(--n-text-color);
}

.modal-subtitle {
  font-size: 0.875rem;
  color: var(--n-text-color-3);
  margin: 4px 0 0;
}

.modal-body {
  padding: 4px 0;
}

.quota-info {
  background: rgba(240, 160, 32, 0.08);
  border: 1px solid rgba(240, 160, 32, 0.25);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 16px;
  text-align: center;
}

.quota-badge {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  margin-bottom: 12px;
}

.quota-num {
  font-size: 2.5rem;
  font-weight: 800;
  color: #f0a020;
  line-height: 1;
}

.quota-text {
  font-size: 1rem;
  color: var(--n-text-color-2);
}

.progress-bar-wrapper {
  height: 6px;
  background: rgba(240, 160, 32, 0.15);
  border-radius: 999px;
  overflow: hidden;
  margin-bottom: 12px;
}

.progress-bar {
  height: 100%;
  background: linear-gradient(90deg, #f0a020, #d03050);
  border-radius: 999px;
}

.quota-desc {
  margin: 0;
  font-size: 0.85rem;
  color: var(--n-text-color-2);
}

.credit-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: rgba(208, 48, 80, 0.06);
  border: 1px solid rgba(208, 48, 80, 0.2);
  border-radius: 10px;
  margin-bottom: 16px;
  font-size: 0.875rem;
}

.benefit-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 4px;
}

.benefit-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.875rem;
  color: var(--n-text-color-2);
}

.modal-footer {
  padding-top: 4px;
}

.topup-cta-btn {
  border-radius: 10px;
  font-weight: 600;
}

/* Override NaiveUI modal card styles */
:deep(.n-card-header) {
  padding-bottom: 0;
}
</style>
