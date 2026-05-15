<script setup>
import { ref, onMounted, h } from 'vue'
import { useMessage, NTag, NButton, NSpace, NCard, NDataTable, NTabs, NTabPane, NForm, NFormItem, NInput, NInputNumber, NSelect, NStatistic, NGrid, NGridItem } from 'naive-ui'
import { useGlobalState } from '../../store'
import { 
  getAdminPricingRules, 
  saveAdminPricingRule, 
  getAdminTransactions, 
  refreshAdminChannels, 
  adjustAdminCredit, 
  getAdminKPIs, 
  getAdminDomains, 
  addAdminDomain, 
  deleteAdminDomain,
  getAdminVouchers,
  createAdminVoucher,
  deleteAdminVoucher
} from '../../api/billing'

const { loading } = useGlobalState()
const message = useMessage()

// KPIs
const kpis = ref({})
const fetchKPIs = async () => {
  try {
    kpis.value = await getAdminKPIs()
  } catch (err) {
    message.error('Failed to fetch KPIs: ' + err.message)
  }
}

// Pricing Rules
const pricingRules = ref([])
const fetchPricingRules = async () => {
  try {
    pricingRules.value = await getAdminPricingRules()
  } catch (err) {
    message.error('Failed to fetch pricing rules: ' + err.message)
  }
}

const showEditRule = ref(false)
const currentRule = ref({ key: '', value: '' })
const editRule = (row) => {
  currentRule.value = { ...row }
  showEditRule.value = true
}
const saveRule = async () => {
  try {
    await saveAdminPricingRule(currentRule.value)
    message.success('Rule saved')
    showEditRule.value = false
    await fetchPricingRules()
  } catch (err) {
    message.error('Failed to save rule: ' + err.message)
  }
}

// Transactions
const transactions = ref([])
const txCount = ref(0)
const txPage = ref(1)
const txPageSize = ref(20)
const fetchTransactions = async () => {
  try {
    const res = await getAdminTransactions({
      limit: txPageSize.value,
      offset: (txPage.value - 1) * txPageSize.value
    })
    transactions.value = res.items
    txCount.value = res.total_count || res.items.length
  } catch (err) {
    message.error('Failed to fetch transactions: ' + err.message)
  }
}

// Domains
const domains = ref([])
const newDomain = ref('')
const fetchDomains = async () => {
  try {
    domains.value = await getAdminDomains()
  } catch (err) {
    message.error('Failed to fetch domains: ' + err.message)
  }
}
const addNewDomain = async () => {
  if (!newDomain.value) return
  try {
    await addAdminDomain(newDomain.value)
    message.success('Domain added')
    newDomain.value = ''
    await fetchDomains()
  } catch (err) {
    message.error('Failed to add domain: ' + err.message)
  }
}
const removeDomain = async (id) => {
  try {
    await deleteAdminDomain(id)
    message.success('Domain removed')
    await fetchDomains()
  } catch (err) {
    message.error('Failed to remove domain: ' + err.message)
  }
}

// Refresh Channels
const handleRefreshChannels = async () => {
  try {
    await refreshAdminChannels()
    message.success('Channels refreshed from DompetX')
  } catch (err) {
    message.error('Failed to refresh channels: ' + err.message)
  }
}

// Vouchers
const vouchers = ref([])
const showAddVoucher = ref(false)
const newVoucher = ref({ code: '', type: 'discount_nominal', value: 0, max_uses: 1 })
const fetchVouchers = async () => {
  try {
    vouchers.value = await getAdminVouchers()
  } catch (err) {
    message.error('Failed to fetch vouchers: ' + err.message)
  }
}
const submitVoucher = async () => {
  try {
    await createAdminVoucher(newVoucher.value)
    message.success('Voucher added')
    showAddVoucher.value = false
    newVoucher.value = { code: '', type: 'discount_nominal', value: 0, max_uses: 1 }
    await fetchVouchers()
  } catch (err) {
    message.error('Failed to add voucher: ' + err.message)
  }
}
const removeVoucher = async (id) => {
  try {
    await deleteAdminVoucher(id)
    message.success('Voucher removed')
    await fetchVouchers()
  } catch (err) {
    message.error('Failed to remove voucher: ' + err.message)
  }
}

// Columns
const ruleColumns = [
  { title: 'Key', key: 'rule_key' },
  { title: 'Value', key: 'rule_value_json' },
  { title: 'Version', key: 'version' },
  {
    title: 'Active',
    key: 'is_active',
    render(row) {
      return h(NTag, { type: row.is_active ? 'success' : 'default' }, { default: () => row.is_active ? 'Yes' : 'No' })
    }
  },
  {
    title: 'Actions',
    key: 'actions',
    render(row) {
      return h(NButton, { size: 'small', onClick: () => editRule(row) }, { default: () => 'Edit' })
    }
  }
]

const txColumns = [
  { title: 'Invoice ID', key: 'invoice_id' },
  { title: 'User ID', key: 'user_id' },
  { title: 'Channel', key: 'channel_code' },
  { title: 'Amount IDR', key: 'amount' },
  { title: 'Fee', key: 'fee' },
  { 
    title: 'Status', 
    key: 'status',
    render(row) {
      const type = row.status === 'paid' ? 'success' : row.status === 'pending' ? 'warning' : 'error'
      return h(NTag, { type }, { default: () => row.status })
    }
  },
  { title: 'Created At', key: 'created_at' }
]

const domainColumns = [
  { title: 'Domain', key: 'domain' },
  {
    title: 'Active',
    key: 'is_active',
    render(row) {
      return h(NTag, { type: row.is_active ? 'success' : 'default' }, { default: () => row.is_active ? 'Yes' : 'No' })
    }
  },
  {
    title: 'Actions',
    key: 'actions',
    render(row) {
      return h(NButton, { size: 'small', type: 'error', onClick: () => removeDomain(row.domain) }, { default: () => 'Delete' })
    }
  }
]

const voucherColumns = [
  { title: 'ID', key: 'id' },
  { title: 'Code', key: 'code' },
  { title: 'Type', key: 'type' },
  { title: 'Value', key: 'value' },
  { title: 'Uses / Max', key: 'uses_max', render(row) { return `${row.uses} / ${row.max_uses}` } },
  {
    title: 'Active',
    key: 'is_active',
    render(row) {
      return h(NTag, { type: row.is_active ? 'success' : 'default' }, { default: () => row.is_active ? 'Yes' : 'No' })
    }
  },
  {
    title: 'Actions',
    key: 'actions',
    render(row) {
      return h(NButton, { size: 'small', type: 'error', onClick: () => removeVoucher(row.id) }, { default: () => 'Delete' })
    }
  }
]

onMounted(() => {
  fetchKPIs()
  fetchPricingRules()
  fetchTransactions()
  fetchDomains()
  fetchVouchers()
})
</script>

<template>
  <div style="padding: 20px;">
    <n-tabs type="line" animated>
      <n-tab-pane name="overview" tab="Overview">
        <n-grid :cols="4" :x-gap="12">
          <n-grid-item>
            <n-card bordered>
              <n-statistic label="Total Revenue (IDR)" :value="kpis.total_revenue_idr || 0" />
            </n-card>
          </n-grid-item>
          <n-grid-item>
            <n-card bordered>
              <n-statistic label="Paid Transactions" :value="kpis.paid_tx_count || 0" />
            </n-card>
          </n-grid-item>
          <n-grid-item>
            <n-card bordered>
              <n-statistic label="Pending Transactions" :value="kpis.pending_tx_count || 0" />
            </n-card>
          </n-grid-item>
          <n-grid-item>
            <n-card bordered>
              <n-statistic label="Active Users (Billing)" :value="kpis.active_user_count || 0" />
            </n-card>
          </n-grid-item>
        </n-grid>
        <n-card title="Quick Actions" style="margin-top: 20px;">
          <n-button type="primary" @click="handleRefreshChannels">Refresh Payment Channels from DompetX</n-button>
        </n-card>
      </n-tab-pane>

      <n-tab-pane name="pricing" tab="Pricing Rules">
        <n-data-table :columns="ruleColumns" :data="pricingRules" />
        <n-modal v-model:show="showEditRule" preset="dialog" title="Edit Pricing Rule">
          <n-form>
            <n-form-item label="Rule Key">
              <n-input v-model:value="currentRule.rule_key" disabled />
            </n-form-item>
            <n-form-item label="Value (JSON)">
              <n-input v-model:value="currentRule.rule_value_json" />
            </n-form-item>
          </n-form>
          <template #action>
            <n-button type="primary" @click="saveRule">Save</n-button>
          </template>
        </n-modal>
      </n-tab-pane>

      <n-tab-pane name="transactions" tab="Transactions">
        <n-data-table 
          remote 
          :columns="txColumns" 
          :data="transactions" 
          :pagination="{
            page: txPage,
            pageSize: txPageSize,
            itemCount: txCount,
            onChange: (p) => { txPage = p; fetchTransactions() }
          }"
        />
      </n-tab-pane>

      <n-tab-pane name="domains" tab="Allowed Domains">
        <n-space vertical>
          <n-input-group>
            <n-input v-model:value="newDomain" placeholder="example.com" />
            <n-button type="primary" @click="addNewDomain">Add Domain</n-button>
          </n-input-group>
          <n-data-table :columns="domainColumns" :data="domains" />
        </n-space>
      </n-tab-pane>
      <n-tab-pane name="vouchers" tab="Vouchers">
        <n-space vertical>
          <n-button type="primary" @click="showAddVoucher = true">Create Voucher</n-button>
          <n-data-table :columns="voucherColumns" :data="vouchers" />
        </n-space>
        
        <n-modal v-model:show="showAddVoucher" preset="dialog" title="Create Voucher">
          <n-form>
            <n-form-item label="Voucher Code">
              <n-input v-model:value="newVoucher.code" placeholder="e.g. DISKON50" />
            </n-form-item>
            <n-form-item label="Type">
              <n-select v-model:value="newVoucher.type" :options="[
                { label: 'Nominal Discount (IDR)', value: 'discount_nominal' },
                { label: 'Percentage Discount (%)', value: 'discount_percent' },
                { label: 'Free Credit / 100%', value: 'free_credit' }
              ]" />
            </n-form-item>
            <n-form-item label="Value (Discount Amount or Percentage)">
              <n-input-number v-model:value="newVoucher.value" :min="0" />
            </n-form-item>
            <n-form-item label="Max Uses">
              <n-input-number v-model:value="newVoucher.max_uses" :min="1" />
            </n-form-item>
          </n-form>
          <template #action>
            <n-button type="primary" @click="submitVoucher">Save</n-button>
          </template>
        </n-modal>
      </n-tab-pane>
    </n-tabs>
  </div>
</template>
