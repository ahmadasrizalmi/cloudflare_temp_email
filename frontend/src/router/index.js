import { createRouter, createWebHistory } from 'vue-router'
import Index from '../views/Index.vue'
import User from '../views/User.vue'
import UserOauth2Callback from '../views/user/UserOauth2Callback.vue'
import WalletHome from '../views/user/wallet/WalletHome.vue'
import WalletTopup from '../views/user/wallet/Topup.vue'
import WalletTopupHistory from '../views/user/wallet/TopupHistory.vue'
import WalletLedger from '../views/user/wallet/Ledger.vue'
import i18n from '../i18n'
import { useGlobalState } from '../store'
import {
    DEFAULT_LOCALE,
    getBrowserLocales,
    getHostDefaultLocale,
    getPreferredLocale,
    getStoredLocale,
    replaceLocaleInFullPath,
    resolveSupportedLocale,
} from '../i18n/utils'

const { jwt, preferredLocale, userJwt } = useGlobalState()

const router = createRouter({
    history: createWebHistory(),
    routes: [
        {
            path: '/',
            alias: '/:lang/',
            component: Index
        },
        {
            path: '/user',
            alias: '/:lang/user',
            component: User
        },
        {
            path: '/user/oauth2/callback',
            alias: '/:lang/user/oauth2/callback',
            component: UserOauth2Callback
        },
        {
            path: '/user/wallet',
            alias: '/:lang/user/wallet',
            component: WalletHome
        },
        {
            path: '/user/wallet/topup',
            alias: '/:lang/user/wallet/topup',
            component: WalletTopup
        },
        {
            path: '/user/wallet/topup/history',
            alias: '/:lang/user/wallet/topup/history',
            component: WalletTopupHistory
        },
        {
            path: '/user/wallet/ledger',
            alias: '/:lang/user/wallet/ledger',
            component: WalletLedger
        },
        {
            path: '/admin',
            alias: '/:lang/admin',
            component: () => import('../views/Admin.vue')
        },
        {
            path: '/telegram_mail',
            alias: '/:lang/telegram_mail',
            component: () => import('../views/telegram/Mail.vue')
        },
        {
            name: 'not-found',
            path: '/:pathMatch(.*)*',
            redirect: '/'
        }
    ]
});

router.beforeEach((to, from, next) => {
    const routeLocale = resolveSupportedLocale(to.path.split('/')[1])
    const storedLocale = getStoredLocale()
    const fallbackLocale = getHostDefaultLocale() === 'id'
        ? 'id'
        : getPreferredLocale(storedLocale, getBrowserLocales())
    const resolvedLocale = routeLocale || preferredLocale.value || storedLocale || fallbackLocale
    i18n.global.locale.value = resolvedLocale

    if (routeLocale) {
        preferredLocale.value = routeLocale
    } else if (!preferredLocale.value) {
        preferredLocale.value = storedLocale || fallbackLocale
    }

    if ((to.path.includes('/user/wallet')) && !userJwt.value) {
        next(replaceLocaleInFullPath('/user', resolvedLocale))
        return
    }

    if (Object.prototype.hasOwnProperty.call(to.query, 'jwt')) {
        const jwtQuery = Array.isArray(to.query.jwt) ? to.query.jwt[0] : to.query.jwt
        if (typeof jwtQuery === 'string') {
            jwt.value = jwtQuery
        }
        const query = { ...to.query }
        delete query.jwt
        next({
            path: to.path,
            query,
            hash: to.hash,
            replace: true,
        })
        return
    }

    if (routeLocale) {
        const canonicalRoutePath = replaceLocaleInFullPath(to.fullPath, routeLocale)
        if (canonicalRoutePath !== to.fullPath) {
            return next(canonicalRoutePath)
        }
    }

    if (routeLocale === DEFAULT_LOCALE) {
        return next(replaceLocaleInFullPath(to.fullPath, DEFAULT_LOCALE))
    }

    next()
});

export default router
