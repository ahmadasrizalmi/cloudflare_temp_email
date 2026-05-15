<script setup>
import { ref, h, onMounted } from 'vue';
import { useScopedI18n } from '@/i18n/app'
import { useRouter } from 'vue-router';
import { NBadge, NPopconfirm, NButton } from 'naive-ui'

import { useGlobalState } from '../../store'
import { api } from '../../api'
import { getRouterPathWithLang } from '../../utils'

import Login from '../common/Login.vue';
import InsufficientCreditModal from '../../components/InsufficientCreditModal.vue';
import { getFreeQuota } from '../../api/billing';

const { jwt, openSettings } = useGlobalState()
const showCreditModal = ref(false)
const freeQuota.used = ref(0)
const freeQuota.limit = ref(1)
const message = useMessage()
const router = useRouter()

const { locale, t } = useScopedI18n('views.user.AddressManagement')

const data = ref([])
const showTranferAddress = ref(false)
const currentAddress = ref("")
const currentAddressId = ref(0)
const targetUserEmail = ref('')

const changeMailAddress = async (address_id) => {
    try {
        const res = await api.fetch(`/user_api/bind_address_jwt/${address_id}`);
        message.success(t('changeMailAddress') + " " + t('success'));
        if (!res.jwt) {
            message.error("jwt not found");
            return;
        }
        jwt.value = res.jwt;
        await router.push(getRouterPathWithLang("/", locale.value))
        location.reload();
    } catch (error) {
        console.log(error)
        message.error(error.message || "error");
    }
}

const unbindAddress = async (address_id) => {
    try {
        const res = await api.fetch(`/user_api/unbind_address`, {
            method: 'POST',
            body: JSON.stringify({ address_id })
        });
        message.success(t('unbindAddress') + " " + t('success'));
        await fetchData();
    } catch (error) {
        console.log(error)
        message.error(error.message || "error");
    }
}

const transferAddress = async () => {
    if (!targetUserEmail.value) {
        message.error("targetUserEmail is required");
        return;
    }
    if (!currentAddressId.value) {
        message.error("currentAddressId is required");
        return;
    }
    try {
        const res = await api.fetch(`/user_api/transfer_address`, {
            method: 'POST',
            body: JSON.stringify({
                address_id: currentAddressId.value,
                target_user_email: targetUserEmail.value
            })
        });
        message.success(t('transferAddress') + " " + t('success'));
        await fetchData();
        showTranferAddress.value = false;
        currentAddressId.value = 0;
        currentAddress.value = "";
        targetUserEmail.value = "";
    } catch (error) {
        console.log(error)
        message.error(error.message || "error");
    }
}

const fetchFreeQuota = async () => {
    if (!openSettings.value.billingEnabled) return;
    try {
        const quota = await getFreeQuota();
        if (quota) {
            freeQuota.value = quota;
        }
    } catch (e) {
        console.warn('fetchFreeQuota failed', e);
    }
}

const fetchData = async () => {
    try {
        const { results } = await api.fetch(
            `/user_api/bind_address`
        );
        data.value = results;
    } catch (error) {
        console.log(error)
        message.error(error.message || "error");
    }
}

const columns = [
    {
        title: t('name'),
        key: "name"
    },
    {
        title: t('mail_count'),
        key: "mail_count",
        render(row) {
            return h(NBadge, {
                value: row.mail_count,
                'show-zero': true,
                max: 99,
                type: "success"
            })
        }
    },
    {
        title: t('send_count'),
        key: "send_count",
        render(row) {
            return h(NBadge, {
                value: row.send_count,
                'show-zero': true,
                max: 99,
                type: "success"
            })
        }
    },
    {
        title: t('actions'),
        key: 'actions',
        render(row) {
            return h('div', [
                h(NPopconfirm,
                    {
                        onPositiveClick: () => changeMailAddress(row.id)
                    },
                    {
                        trigger: () => h(NButton,
                            {
                                tertiary: true,
                                type: "primary",
                            },
                            { default: () => t('changeMailAddress') }
                        ),
                        default: () => `${t('changeMailAddress')}?`
                    }
                ),
                h(NButton,
                    {
                        tertiary: true,
                        type: "primary",
                        onClick: () => {
                            currentAddressId.value = row.id;
                            currentAddress.value = row.name;
                            showTranferAddress.value = true;
                        }
                    },
                    { default: () => t('transferAddress') }
                ),
                h(NPopconfirm,
                    {
                        onPositiveClick: () => unbindAddress(row.id)
                    },
                    {
                        trigger: () => h(NButton,
                            {
                                tertiary: true,
                                type: "error",
                            },
                            { default: () => t('unbindAddress') }
                        ),
                        default: () => t('unbindAddressTip')
                    }
                ),
            ])
        }
    }
]

onMounted(async () => {
    await fetchData()
    await fetchFreeQuota()
})
</script>

<template>
    <div>


        <!-- Free Quota Banner (only when billing enabled) -->
        <n-alert
            v-if="openSettings.billingEnabled"
            :type="freeQuota.used >= freeQuota.limit ? 'warning' : 'success'"
            class="quota-banner"
            :bordered="false"
        >
            <template #icon>
                <n-icon>
                    <span style="font-size:16px">📧</span>
                </n-icon>
            </template>
            <n-space align="center" justify="space-between" style="width:100%">
                <span>
                    <strong>Email Gratis:</strong> {{ freeQuota.used }} / {{ freeQuota.limit }} digunakan
                    <span v-if="freeQuota.used >= freeQuota.limit" style="color:#d03050"> — Habis! Beli kredit untuk email berikutnya.</span>
                </span>
                <n-button
                    v-if="freeQuota.used >= freeQuota.limit"
                    size="small"
                    type="warning"
                    @click="showInsufficientCreditModal = true"
                >
                    💳 Beli Kredit
                </n-button>
            </n-space>
        </n-alert>

        <n-modal v-model:show="showTranferAddress" preset="dialog" :title="t('transferAddress')">
            <span>
                <p>{{ t("transferAddressTip") }}</p>
                <p>{{ t('transferAddress') + ": " + currentAddress }}</p>
                <n-input v-model:value="targetUserEmail" :placeholder="t('targetUserEmail')" />
            </span>
            <template #action>
                <n-button :loading="loading" @click="transferAddress" size="small" tertiary type="error">
                    {{ t('transferAddress') }}
                </n-button>
            </template>
        </n-modal>
        <n-tabs type="segment">
            <n-tab-pane name="address" :tab="t('address')">
                <div class="address-table-scroll">
                    <n-data-table :columns="columns" :data="data" :bordered="false" embedded />
                </div>
            </n-tab-pane>
            <n-tab-pane name="create_or_bind" :tab="t('create_or_bind')">
                <Login />
            </n-tab-pane>
        </n-tabs>
    </div>
</template>

<style scoped>
.n-data-table {
    min-width: 640px;
}

.address-table-scroll {
    max-width: 100%;
    overflow-x: auto;
}

.quota-banner {
    margin-bottom: 12px;
    border-radius: 10px;
}
</style>
