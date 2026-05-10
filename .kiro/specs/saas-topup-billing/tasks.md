# Implementation Plan: SaaS Top-up Billing (`automation.my.id`)

> Instruction: Convert the feature design into a series of prompts for a code-generation LLM that will implement each step with incremental progress. Make sure that each prompt builds on the previous prompts, and ends with wiring things together. There should be no hanging or orphaned code that isn't integrated into a previous step. Focus ONLY on tasks that involve writing, modifying, or testing code.

## Overview

Implementation proceeds bottom-up: (1) D1 schema + shared TypeScript types + i18n scaffolding, (2) pure internal services (Pricing_Engine, Wallet_Service, DompetX client, Channel_Cache, Abuse_Guard, grandfather helper), (3) HTTP surfaces (user Billing_API, Payment_Webhook, public channels, Admin_API), (4) paid-action integration into existing `/api/*` and `/user_api/*` handlers plus the Email Worker forward path, (5) scheduled Topup_Reconciler + auto margin guard, (6) frontend Wallet UI + fingerprint wiring, (7) Indonesian locale + fallback behaviour, (8) integration + E2E tests + docs + changelog. Every one of the 37 correctness properties from `design.md` is turned into its own `fast-check` property-based test sub-task that is annotated with the property number and the requirements clause it validates.

## Tasks

- [x] 1. Foundation — D1 schema, shared types, i18n keys, wrangler vars
  - [x] 1.1 Create D1 migration `db/2026-05-15-billing-wallet.sql` for the billing feature
  - [x] 1.2 Add billing TypeScript models and shared type definitions
  - [x] 1.3 Register billing i18n keys in existing `en` and `zh` locales
  - [x] 1.4 Extend wrangler configuration with billing vars, secrets placeholder, and cron trigger

- [x] 2. Pricing_Engine
  - [x] 2.1 Implement `Pricing_Engine` at `worker/src/billing/pricing_engine.ts`
  - [x] 2.2 Write property test for Pricing_Engine: Property 7 (pricing resolution correctness)
  - [x] 2.3 Write property test for Pricing_Engine: Property 8 (cache determinism)

- [x] 3. Wallet_Service
  - [x] 3.1 Implement `Wallet_Service` at `worker/src/billing/wallet_service.ts`
  - [x] 3.2 Write property test for Wallet_Service: Property 1 (ledger sum invariant)
  - [x] 3.3 Write property test for Wallet_Service: Property 2 (no-negative-balance invariant)
  - [x] 3.4 Write property test for Wallet_Service: Property 3 (sign and type invariant)
  - [x] 3.5 Write property test for Wallet_Service: Property 4 (ledger append-only)
  - [x] 3.6 Write property test for Wallet_Service: Property 5 (DEBIT metadata completeness)
  - [x] 3.7 Write property test for Wallet_Service: Property 6 (debit/refund round-trip)
  - [x] 3.8 Write property test for Wallet_Service: Property 23 (bonus formula and atomicity)
  - [x] 3.9 Write property test for Wallet_Service: Property 35 (wallet creation eager and lazy)

- [x] 4. DompetX client
  - [x] 4.1 Implement DompetX client at `worker/src/billing/dompetx_client.ts`
  - [x] 4.2 Write unit tests for DompetX client

- [x] 5. Channel_Cache
  - [x] 5.1 Implement `Channel_Cache` at `worker/src/billing/channel_cache.ts`
  - [x] 5.2 Write property test for Channel_Cache: Property 15 (channel filter correctness)
  - [x] 5.3 Write property test for Channel_Cache: Property 16 (channel quote fee and gross formula)

- [x] 6. Abuse_Guard
  - [x] 6.1 Implement `Abuse_Guard` at `worker/src/billing/abuse_guard.ts`
  - [x] 6.2 Write property test for Abuse_Guard: Property 28 (user rate limits)
  - [x] 6.3 Write property test for Abuse_Guard: Property 29 (IP new-user abuse guard)
  - [x] 6.4 Write property test for Abuse_Guard: Property 30 (fingerprint required)

- [x] 7. Billing_API (user endpoints)
  - [x] 7.1 Implement user-facing billing handlers at `worker/src/user_api/billing.ts`
  - [x] 7.2 Register billing routes in `worker/src/user_api/index.ts`
  - [x] 7.3 Write property test for user Billing_API: Property 11 (domain preview matches Pricing_Engine)
  - [x] 7.4 Write property test for user Billing_API: Property 14 (min top-up guard short-circuits DompetX)
  - [x] 7.5 Write property test for user Billing_API: Property 17 (top-up create persistence and eligibility)
  - [x] 7.6 Write property test for user Billing_API: Property 25 (pagination and ordering)

- [x] 8. Payment_Webhook
  - [x] 8.1 Implement Payment_Webhook at `worker/src/open_api/payment_webhook.ts`
  - [x] 8.2 Wire webhook + open_api routes in `worker/src/worker.ts`
  - [x] 8.3 Write property test for Payment_Webhook: Property 18 (signature verification)
  - [x] 8.4 Write property test for Payment_Webhook: Property 19 (`paid` state transition)
  - [x] 8.5 Write property test for Payment_Webhook: Property 20 (idempotency across replays)
  - [x] 8.6 Write property test for Payment_Webhook: Property 21 (terminal non-paid transitions)
  - [x] 8.7 Write property test for Payment_Webhook: Property 22 (`raw_payload` masking)

- [x] 9. Public payment channels endpoint
  - [x] 9.1 Implement `GET /open_api/payment_channels` at `worker/src/open_api/payment_channels.ts`

- [x] 10. Checkpoint — first billing backend milestone

- [x] 11. Paid-action integration and grandfather policy
  - [x] 11.1 Integrate `create_address` debit path
  - [x] 11.2 Integrate `send_mail` debit path
  - [x] 11.3 Integrate `forward_mail` debit path in the Email Worker
  - [x] 11.4 Implement grandfather policy helper at `worker/src/billing/grandfather.ts`
  - [x] 11.5 Write property test for paid-action integration: Property 12 (insufficient-credit rejection)
  - [x] 11.6 Write property test for paid-action integration: Property 13 (disallowed-domain rejection)
  - [x] 11.7 Write property test for paid-action integration: Property 33 (grandfather policy)

- [x] 12. Billing_Admin_API
  - [x] 12.1 Implement admin `pricing_rules` endpoints at `worker/src/admin_api/billing_admin.ts`
  - [x] 12.2 Implement admin topup transactions endpoints in `billing_admin.ts`
  - [x] 12.3 Implement admin channels refresh endpoint in `billing_admin.ts`
  - [x] 12.4 Implement admin credit adjust endpoint in `billing_admin.ts`
  - [x] 12.5 Implement admin KPI endpoint in `billing_admin.ts`
  - [x] 12.6 Implement admin domains endpoints in `billing_admin.ts`
  - [x] 12.7 Register admin billing routes in `worker/src/admin_api/index.ts`
  - [x] 12.8 Write property test for Admin API: Property 9 (active-version selection + atomic update)
  - [x] 12.9 Write property test for Admin API: Property 10 (pricing-rule admin validation)
  - [x] 12.10 Write property test for Admin API: Property 26 (admin transactions filter correctness)
  - [x] 12.11 Write property test for Admin API: Property 27 (credit adjust ledger + audit)
  - [x] 12.12 Write property test for Admin API: Property 31 (KPI aggregate correctness)

- [x] 13. Topup_Reconciler, auto margin guard, and scheduled hook
  - [x] 13.1 Implement `Topup_Reconciler` at `worker/src/billing/reconciler.ts`
  - [x] 13.2 Implement auto margin guard inside the reconciler
  - [x] 13.3 Wire reconciler into the scheduled handler in `worker/src/scheduled.ts`
  - [x] 13.4 Write property test for Reconciler: Property 24 (expires + late paid)
  - [x] 13.5 Write property test for Reconciler: Property 32 (auto margin guard upper bound)
  - [x] 13.6 Write property test for migration: Property 34 (migration back-fill idempotency)

- [x] 14. Startup validation and secret non-leakage
  - [x] 14.1 Add boot-time secret validation hook in `worker/src/worker.ts`
  - [x] 14.2 Write property test: Property 36 (secret non-leakage in responses)

- [x] 15. Checkpoint — worker-side billing complete

- [x] 16. Frontend Wallet UI
  - [x] 16.1 Add billing API client and fingerprint wiring at `frontend/src/api/billing.js`
  - [x] 16.2 Add wallet store slice at `frontend/src/store/index.js`
  - [x] 16.3 Create `WalletHome.vue` at `frontend/src/views/user/wallet/WalletHome.vue`
  - [x] 16.4 Create `Topup.vue` at `frontend/src/views/user/wallet/Topup.vue`
  - [x] 16.5 Create `TopupHistory.vue` at `frontend/src/views/user/wallet/TopupHistory.vue`
  - [x] 16.6 Create `Ledger.vue` at `frontend/src/views/user/wallet/Ledger.vue`
  - [x] 16.7 Add credit-cost preview on the address creation form
  - [x] 16.8 Wire wallet routes in `frontend/src/router/` and navigation entry
  - [x] 16.9 Write unit test: Topup.vue preset and channel computation
  - [x] 16.10 Write unit test: axios interceptor auto-refreshes wallet on 402

- [x] 17. Indonesian locale and fallback
  - [x] 17.1 Add worker i18n locale `id` at `worker/src/i18n/id.ts`
  - [x] 17.2 Add frontend locale `id` under `frontend/src/i18n/locales/`
  - [x] 17.3 Default locale to `id` for `automation.my.id`
  - [x] 17.4 Write property test: Property 37 (i18n fallback)

- [x] 18. Integration tests (mocked externals)
  - [x] 18.1 Write integration test: admin channels refresh against mocked DompetX list endpoint
  - [x] 18.2 Write integration test: admin domains add against mocked Cloudflare Email Routing API
  - [x] 18.3 Write integration test: scheduled cron trigger invokes reconciler
  - [x] 18.4 Write integration test: startup failure when billing secrets are missing
  - [x] 18.5 Write integration test: schema unique constraints on `topup_transactions`

- [x] 19. E2E tests (Playwright, under `e2e/tests/api/`)
  - [x] 19.1 Write `billing-topup-happy.spec.ts`
  - [x] 19.2 Write `billing-webhook-idempotency.spec.ts`
  - [x] 19.3 Write `billing-insufficient-credit.spec.ts`
  - [x] 19.4 Write `billing-domain-cost-preview.spec.ts`
  - [x] 19.5 Write `billing-rate-limit.spec.ts`

- [x] 20. Documentation and changelog
  - [x] 20.1 Add VitePress billing feature guide (zh + en)
  - [x] 20.2 Update `guide/worker-vars.md` (zh + en) with new environment variables
  - [x] 20.3 Add VitePress API reference docs (zh + en)
  - [x] 20.4 Update `CHANGELOG.md` (zh) and `CHANGELOG_EN.md` (en)

- [x] 21. Final checkpoint
