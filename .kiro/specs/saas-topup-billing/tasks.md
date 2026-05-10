# Implementation Plan: SaaS Top-up Billing (`automation.my.id`)

> Instruction: Convert the feature design into a series of prompts for a code-generation LLM that will implement each step with incremental progress. Make sure that each prompt builds on the previous prompts, and ends with wiring things together. There should be no hanging or orphaned code that isn't integrated into a previous step. Focus ONLY on tasks that involve writing, modifying, or testing code.

## Overview

Implementation proceeds bottom-up: (1) D1 schema + shared TypeScript types + i18n scaffolding, (2) pure internal services (Pricing_Engine, Wallet_Service, DompetX client, Channel_Cache, Abuse_Guard, grandfather helper), (3) HTTP surfaces (user Billing_API, Payment_Webhook, public channels, Admin_API), (4) paid-action integration into existing `/api/*` and `/user_api/*` handlers plus the Email Worker forward path, (5) scheduled Topup_Reconciler + auto margin guard, (6) frontend Wallet UI + fingerprint wiring, (7) Indonesian locale + fallback behaviour, (8) integration + E2E tests + docs + changelog. Every one of the 37 correctness properties from `design.md` is turned into its own `fast-check` property-based test sub-task that is annotated with the property number and the requirements clause it validates.

## Tasks

- [x] 1. Foundation — D1 schema, shared types, i18n keys, wrangler vars
  - [x] 1.1 Create D1 migration `db/2026-05-15-billing-wallet.sql` for the billing feature
    - Add tables: `wallets`, `credit_ledger`, `topup_transactions`, `pricing_rules`, `payment_channels_cache`, `allowed_domains`, `billing_audit_logs` with all columns, CHECK constraints, UNIQUE indexes, and supporting indexes from design.md §"D1 schema additions"
    - Enforce `CHECK (balance_credit >= 0)` on `wallets`, sign/type CHECK on `credit_ledger`, `UNIQUE(idempotency_key, type)` partial index, and `UNIQUE(invoice_id)` + `UNIQUE(provider_reference)` on `topup_transactions`
    - Include an `INSERT OR IGNORE INTO wallets SELECT id, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM users` back-fill statement so repeated migration runs are idempotent
    - Seed the 12 default `pricing_rules` rows listed in design.md §"Default pricing_rules seed" (`domain_weight_com=4`, `domain_weight_default=1`, `action_cost_create_address=1`, `action_cost_send_mail=5`, `action_cost_forward_mail=5`, `credit_idr_rate=100`, `bonus_threshold_idr=100000`, `bonus_rate_percent=5`, `min_topup_idr=10000`, `margin_guard_auto=true`, `margin_guard_target_percent=55`, `grandfather_period_days=30`) each with `version=1`, `is_active=1`
    - Seed `allowed_domains` with the six active domains listed in Requirement 2.1
    - Append the filename to `db/schema.sql` comment header so `schema.sql` stays the authoritative copy
    - _Requirements: 3.4, 5.8, 6.4, 7.3, 14.7, 18.6_

  - [x] 1.2 Add billing TypeScript models and shared type definitions
    - Create `worker/src/models/billing.ts` with `WalletRow`, `LedgerEntry`, `LedgerMetadata`, `LedgerType` union, `TopupRow`, `PricingRuleRow`, `AllowedDomainRow`, `PaymentChannel`, `PaymentChannelQuote`, `BillingErrorCode` union, and a `RuleKey` string union mirroring design.md §"TypeScript models" and §"Pricing_Engine"
    - Extend `worker/src/types.d.ts` with new bindings (`DOMPETX_API_KEY`, `DOMPETX_API_SECRET`, `DOMPETX_WEBHOOK_SECRET`, `CLOUDFLARE_EMAIL_ROUTING_TOKEN`, `BILLING_ENABLED`, `BILLING_LAUNCH_AT`, `DEFAULT_LANG`) and the `BILLING_RATE_LIMITER` KV / rate-limit binding reference
    - Export `BILLING_LEDGER_TYPES`, `BILLING_TOPUP_STATUSES`, `BILLING_ERROR_CODES` as `const` arrays for runtime validation
    - _Requirements: 3.3, 5.4, 15.1, 15.2_

  - [x] 1.3 Register billing i18n keys in existing `en` and `zh` locales
    - Add the 12 error message keys from design.md §"Error taxonomy and HTTP mapping" (`InsufficientCreditMsg`, `DomainNotAllowedMsg`, `NominalBelowMinimumMsg`, `ChannelNotEligibleMsg`, `FingerprintRequiredMsg`, `RateLimitedMsg`, `DuplicateInvoiceMsg`, `MarginGuardViolationMsg`, `MinTopupViolationMsg`, `NegativeBalanceNotAllowedMsg`, `UnknownActionMsg`, `InvoiceNotFoundMsg`) to `worker/src/i18n/type.ts`, `worker/src/i18n/en.ts`, `worker/src/i18n/zh.ts`
    - Wire them through `worker/src/i18n/index.ts` so `getI18n(lang).<key>` resolves and falls through to `en` when a locale lacks a key
    - _Requirements: 2.5, 2.6, 4.3, 4.9, 7.4, 7.5, 9.4, 10.1, 10.5, 17.2, 17.3_

  - [x] 1.4 Extend wrangler configuration with billing vars, secrets placeholder, and cron trigger
    - Update `worker/wrangler.toml.template` `[vars]` with `BILLING_ENABLED`, `BILLING_LAUNCH_AT`, `DEFAULT_LANG = "id"` scoped to `automation.my.id`
    - Declare the four `wrangler secret` names (`DOMPETX_API_KEY`, `DOMPETX_API_SECRET`, `DOMPETX_WEBHOOK_SECRET`, `CLOUDFLARE_EMAIL_ROUTING_TOKEN`) in the template comments
    - Add `[triggers] crons = ["*/5 * * * *"]` (merging with any existing cron definitions) for the Topup_Reconciler
    - Add an optional `BILLING_RATE_LIMITER` KV namespace binding reusing the existing KV store with a `rl:` key prefix convention documented inline
    - _Requirements: 5.2, 8.3, 10.6, 15.1, 15.2_

- [x] 2. Pricing_Engine
  - [x] 2.1 Implement `Pricing_Engine` at `worker/src/billing/pricing_engine.ts`
    - Implement `resolve(action, domain)`, `getNumber(ruleKey)`, `getObject<T>(ruleKey)`, `invalidateCache()`, `listDomainCosts(action)` per the `PricingEngine` interface in design.md §"Pricing_Engine"
    - Read only rows with `is_active=1 AND MAX(version)` via `SELECT … ORDER BY version DESC LIMIT 1` per `rule_key`
    - Implement the resolution algorithm: `create_address = domainWeight * action_cost_create_address`; `send_mail = action_cost_send_mail` (constant); `forward_mail = action_cost_forward_mail` (constant); throw `unknown_action` for unrecognised `action_key`
    - Implement module-level `Map<ruleKey, {value, expiresAt}>` cache with 60-second TTL; `invalidateCache()` clears the map
    - Export a `createPricingEngine(db)` factory so tests can inject an in-memory D1 adapter
    - _Requirements: 2.2, 2.4, 6.1, 6.5, 7.2, 7.3, 7.7, 13.2_

  - [x] 2.2 Write property test for Pricing_Engine: Property 7 (pricing resolution correctness)
    - Create `worker/src/billing/__tests__/pricing_engine.property.test.ts` with `// Feature: saas-topup-billing, Property 7: Pricing resolution correctness`
    - Use `fast-check` generators for `(action_key ∈ {create_address, send_mail, forward_mail}, domain suffixes ∈ {.com, .web.id, .my.id, .id, .co.id}, domain_weight_com ∈ [1..5], domain_weight_default ∈ [1..3])`
    - Seed active pricing rules, call `resolve(action, domain)`, assert equality with the pure-function derivation from design.md
    - Run with `{ numRuns: 100 }`
    - **Property 7: Pricing resolution correctness**
    - **Validates: Requirements 2.2, 2.4, 6.1, 6.5, 13.2, 19.3**

  - [x] 2.3 Write property test for Pricing_Engine: Property 8 (cache determinism)
    - Append a describe block to `pricing_engine.property.test.ts` with `// Feature: saas-topup-billing, Property 8: Pricing cache determinism`
    - Generator produces a fixed set of pricing rules and a sequence of N `resolve(action, domain)` calls within a simulated 60-second window (monkey-patch `Date.now`)
    - Assert every call returns the same value; then advance time past 60s, mutate the rule row in place, assert cache expires and a new read returns the new value
    - **Property 8: Pricing cache determinism**
    - **Validates: Requirements 7.2, 19.8**

- [ ] 3. Wallet_Service
  - [x] 3.1 Implement `Wallet_Service` at `worker/src/billing/wallet_service.ts`
    - Implement `ensureWallet`, `getSnapshot`, `listLedger`, `debit`, `refund`, `creditTopup`, `adjust` per the `WalletService` interface in design.md §"Wallet_Service"
    - Every mutation uses a single `db.batch([...])` combining: conditional `UPDATE wallets SET balance_credit = balance_credit ± ? WHERE user_id = ? AND balance_credit >= ?` (for debits, to guarantee no-negative balance), followed by `INSERT INTO credit_ledger(...)`
    - `debit` returns `InsufficientCreditError` when `rows_affected == 0`; emits ledger metadata `{action_key, domain, resource_id}`
    - `refund` writes ledger `REFUND` with `metadata.refund_of = refundOfLedgerId` and `idempotency_key = 'refund:' + refundOfLedgerId` so repeated calls are idempotent
    - `creditTopup` computes `topup_credits = floor(amountIdr / creditIdrRate)`; when `amountIdr >= bonusThresholdIdr` also inserts a `BONUS` row with `credit_delta = floor(amountIdr * bonusRatePercent / 100 / creditIdrRate)`; both rows share `idempotency_key = invoiceId`; the `UNIQUE(idempotency_key, type)` index makes replays no-ops (catch + swallow unique-violation, re-read, return snapshot)
    - `adjust` rejects resulting balance < 0 before writing any row; writes `ADJUST` ledger with `metadata.admin_id, metadata.reason`
    - `listLedger` orders by `created_at DESC`, enforces `limit <= 100`, returns an opaque base64 cursor encoding `(created_at, id)` for stable pagination
    - _Requirements: 1.2, 1.3, 3.1, 3.2, 3.3, 3.4, 3.6, 5.4, 6.2, 6.3, 6.4, 6.6, 6.7, 9.3, 9.4, 11.1, 11.2, 11.3, 11.6_

  - [x] 3.2 Write property test for Wallet_Service: Property 1 (ledger sum invariant)
    - Create `worker/src/billing/__tests__/wallet_service.property.test.ts` with `// Feature: saas-topup-billing, Property 1: Ledger sum invariant`
    - `fast-check` model-based generator emits random command sequences (`topup`, `debit`, `refund`, `adjust`, `bonus`) on a small set of user ids
    - After every committed operation assert `SUM(credit_ledger.credit_delta WHERE user_id = u) === wallets.balance_credit WHERE user_id = u` for every user
    - **Property 1: Ledger sum invariant**
    - **Validates: Requirements 3.4, 19.1**

  - [~] 3.3 Write property test for Wallet_Service: Property 2 (no-negative-balance invariant)
    - Append describe block to `wallet_service.property.test.ts`: `// Feature: saas-topup-billing, Property 2: No-negative-balance invariant`
    - Generator produces arbitrary interleavings of `debit` and `adjust` calls with random credit amounts including negative adjust values that would overshoot the balance
    - Assert `wallets.balance_credit >= 0` after every committed step, and that overshooting calls return `InsufficientCreditError` / `negative_balance_not_allowed` without mutating either `wallets` or `credit_ledger`
    - **Property 2: No-negative-balance invariant**
    - **Validates: Requirements 6.4, 9.4, 19.6**

  - [~] 3.4 Write property test for Wallet_Service: Property 3 (sign and type invariant)
    - Append describe block: `// Feature: saas-topup-billing, Property 3: Ledger sign and type invariant`
    - Generator applies random commands; after every insert assert the DB row satisfies: `type='DEBIT' ⇔ credit_delta<0`, `type∈{TOPUP,BONUS,REFUND} ⇔ credit_delta>0`, `type='ADJUST' ⇔ credit_delta!=0`
    - **Property 3: Ledger sign and type invariant**
    - **Validates: Requirements 19.9**

  - [~] 3.5 Write property test for Wallet_Service: Property 4 (append-only ledger)
    - Append describe block: `// Feature: saas-topup-billing, Property 4: Ledger append-only`
    - Generator snapshots the full ledger table before and after every service call; assert row count is monotonically non-decreasing and all previously observed tuples `(id, type, credit_delta, user_id, idempotency_key, metadata, created_at)` remain bit-identical
    - **Property 4: Ledger append-only**
    - **Validates: Requirements 3.6**

  - [~] 3.6 Write property test for Wallet_Service: Property 5 (DEBIT metadata completeness)
    - Append describe block: `// Feature: saas-topup-billing, Property 5: DEBIT metadata completeness`
    - Generator randomises `(action_key, domain, resource_id)` across `debit` calls; assert the inserted ledger row's `metadata` JSON is parseable and contains non-empty `action_key`, `domain`, `resource_id` fields
    - **Property 5: DEBIT metadata completeness**
    - **Validates: Requirements 6.6**

  - [~] 3.7 Write property test for Wallet_Service: Property 6 (debit/refund round-trip)
    - Append describe block: `// Feature: saas-topup-billing, Property 6: Debit/refund round-trip`
    - Generator creates a random `debit`, then a matching `refund(refundOfLedgerId = debit.ledgerId)`; assert net balance delta is zero, the `REFUND.metadata.refund_of` equals the DEBIT id, and calling `refund` twice with the same `refundOfLedgerId` inserts only one ledger row
    - **Property 6: Debit/refund round-trip**
    - **Validates: Requirements 6.2, 6.7**

  - [~] 3.8 Write property test for Wallet_Service: Property 23 (bonus formula and atomicity)
    - Append describe block: `// Feature: saas-topup-billing, Property 23: Bonus formula and atomicity`
    - Generator randomises `(amountIdr, bonus_threshold_idr, bonus_rate_percent, credit_idr_rate, invoiceId)`; call `creditTopup`; assert:
      - when `amountIdr >= bonus_threshold_idr` a BONUS row exists with `credit_delta = floor(amountIdr * bonus_rate_percent / 100 / credit_idr_rate)` and shares the same `idempotency_key` as the TOPUP row
      - when `amountIdr < bonus_threshold_idr` no BONUS row exists
      - observable state after commit contains either both rows or neither (simulate mid-batch failure by injecting a failing DB driver that aborts the batch)
    - **Property 23: Bonus formula and atomicity**
    - **Validates: Requirements 11.1, 11.2, 11.3, 19.7**

  - [~] 3.9 Write property test for Wallet_Service: Property 35 (wallet creation eager and lazy)
    - Append describe block: `// Feature: saas-topup-billing, Property 35: Wallet creation`
    - Generator produces arbitrary sequences of `register` and `GET /user_api/wallet` calls for random user ids (using a Hono test client against the in-memory DB)
    - Assert after register a wallet row with zeros exists immediately; for users without a wallet, the first `GET /user_api/wallet` creates the row; subsequent calls do not insert additional rows (row count per user stays at 1)
    - **Property 35: Wallet creation (eager and lazy)**
    - **Validates: Requirements 1.2, 1.3**

- [ ] 4. DompetX client
  - [x] 4.1 Implement DompetX client at `worker/src/billing/dompetx_client.ts`
    - Implement `createInvoice`, `getInvoiceStatus`, `listChannels`, `verifyWebhookSignature(rawBody, timestamp, signatureHex)` (uses `timingSafeEqual` equivalent) per design.md §"DompetX client"
    - Add HMAC-SHA256 signing over `timestamp + "." + raw_body` with `DOMPETX_API_SECRET` for outbound calls
    - Implement retry: at most 2 retries with 250ms / 750ms jittered backoff on 5xx; never on 4xx; surface `DompetxError` with mapped code
    - Export a `DompetxClient` interface so tests can inject a mock
    - _Requirements: 4.6, 5.2, 8.4, 9.1, 15.1_

  - [x] 4.2 Write unit tests for DompetX client
    - Create `worker/src/billing/__tests__/dompetx_client.test.ts`
    - Cover: signature verification accepts valid HMAC + timestamp within 300s; rejects tampered body/timestamp/signature; `createInvoice` retries exactly twice on 5xx then throws; never retries on 4xx; sensitive keys never logged (assert via a spy-able logger)
    - _Requirements: 5.2, 5.3, 15.4_

- [x] 5. Channel_Cache
  - [x] 5.1 Implement `Channel_Cache` at `worker/src/billing/channel_cache.ts`
    - Implement `listPublic(nominal?)`, `listForQuote(nominal)`, `refresh()` per the `ChannelCache` interface
    - `listForQuote` returns `estimated_fee` computed from `fee_type ∈ {percentage, fixed, mixed}` using `fee_value`, `fee_fixed`; `gross_amount = nominal + estimated_fee` iff `fee_bearer='customer'`, else `gross_amount = nominal`
    - Implement 10-minute TTL cache keyed on `nominal`; stale-while-revalidate via `ctx.waitUntil(this.refresh())` when stale; `refresh()` calls DompetX `listChannels` and rewrites `payment_channels_cache` in one `db.batch` (delete + reinsert)
    - Strip `api_key`, `signature_secret`, `raw` fields before returning to callers
    - _Requirements: 4.2, 4.4, 9.1, 16.2, 16.3, 16.4, 16.5_

  - [x] 5.2 Write property test for Channel_Cache: Property 15 (channel filter correctness)
    - Create `worker/src/billing/__tests__/channel_cache.property.test.ts` with `// Feature: saas-topup-billing, Property 15: Channel filter correctness`
    - Generator produces random `payment_channels_cache` rows `(min, max ∈ ℤ∪{null}, is_active ∈ {0,1})` and arbitrary `nominal ∈ ℤ⁺ ∪ {undefined}`
    - Assert every row returned by `listPublic(nominal)` and `listForQuote(nominal)` satisfies `is_active=1 AND (nominal===undefined OR (nominal >= min AND (max IS NULL OR nominal <= max)))`
    - **Property 15: Channel-filter correctness**
    - **Validates: Requirements 4.4, 16.2, 16.3, 19.5**

  - [x] 5.3 Write property test for Channel_Cache: Property 16 (channel quote fee and gross formula)
    - Append describe block: `// Feature: saas-topup-billing, Property 16: Channel quote fee and gross formula`
    - Generator varies `(fee_type, fee_value, fee_fixed, fee_bearer, nominal)` across all four fee types
    - Assert `estimated_fee == computeFee(channel, nominal)` (re-implement `computeFee` pure function inline in the test); assert `gross_amount == nominal + estimated_fee` iff `fee_bearer='customer'`, else `gross_amount == nominal`
    - **Property 16: Channel quote fee and gross formula**
    - **Validates: Requirements 4.2, 4.7, 4.8**

- [ ] 6. Abuse_Guard
  - [x] 6.1 Implement `Abuse_Guard` at `worker/src/billing/abuse_guard.ts`
    - Implement `requireFingerprint(c)` — throws HTTP 400 `fingerprint_required` when `x-fingerprint` header is empty/missing; computes `sha256(fingerprint)` and attaches to `c.var.fingerprint_hash`
    - Implement `checkTopupQuote(c)` — KV counter `rl:quote:{user_id}:{bucketMinute}` TTL 60s, max 30/min/user; throws HTTP 429 `rate_limited` on excess
    - Implement `checkTopupCreate(c)` — KV counter `rl:topup:{user_id}:{bucket10min}` TTL 600s, max 5/10min/user; additional IP-new-user guard `rl:ipnew:{ip}:{bucketHour}` tracking unique `user_id`s; when >10 unique users within 1h set `rl:ipblock:{ip}` TTL 3600s and write a `billing_audit_logs` row with `event_type='ip_block'`
    - `fail-closed` on KV unavailability for create, `fail-open` for quote (log + allow) as per design.md §"Failure modes" #6
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_

  - [~] 6.2 Write property test for Abuse_Guard: Property 28 (user rate limits)
    - Create `worker/src/billing/__tests__/abuse_guard.property.test.ts` with `// Feature: saas-topup-billing, Property 28: User-level rate limits`
    - Generator produces arbitrary bursts of requests by a single user over a simulated time window (monkey-patch `Date.now`)
    - Assert request N+1 returns 429 when N reaches the configured cap (30 for quote, 5 for create); rejected requests leave no mutation in `topup_transactions` or `billing_audit_logs`
    - **Property 28: User-level rate limits**
    - **Validates: Requirements 10.1, 10.2**

  - [~] 6.3 Write property test for Abuse_Guard: Property 29 (IP new-user abuse guard)
    - Append describe block: `// Feature: saas-topup-billing, Property 29: IP new-user abuse guard`
    - Generator produces requests from the same IP by a varying number of distinct user ids within a 1-hour simulated window
    - Assert after >10 distinct new users the next request from that IP is blocked for ≥1h and exactly one `billing_audit_logs` row with `event_type='ip_block'` is written per blocking event
    - **Property 29: IP new-user abuse guard**
    - **Validates: Requirements 10.4**

  - [~] 6.4 Write property test for Abuse_Guard: Property 30 (fingerprint required)
    - Append describe block: `// Feature: saas-topup-billing, Property 30: Fingerprint required`
    - Generator produces requests with random header shapes (missing, empty string, whitespace-only, valid hex, long random)
    - Assert the response is HTTP 400 with code `fingerprint_required` iff the header is missing / empty / whitespace; no state mutation for rejected requests
    - **Property 30: Fingerprint required**
    - **Validates: Requirements 10.5**

- [ ] 7. Billing_API (user endpoints)
  - [x] 7.1 Implement user-facing billing handlers at `worker/src/user_api/billing.ts`
    - Implement all routes from design.md §"Billing_API endpoints": `GET /user_api/wallet`, `GET /user_api/wallet/ledger`, `GET /user_api/billing/domains`, `POST /user_api/topup/quote`, `POST /user_api/topup/create`, `GET /user_api/topup/history`
    - `POST /user_api/topup/quote` — `Abuse_Guard.requireFingerprint` + `checkTopupQuote` → reject `nominal < min_topup_idr` (HTTP 400 `nominal_below_minimum`, do NOT call DompetX) → `Channel_Cache.listForQuote(nominal)` → return array with `bonus_hint` flag when `nominal >= bonus_threshold_idr`
    - `POST /user_api/topup/create` — `requireFingerprint` + `checkTopupCreate` → min_topup guard → validate `channel_code` eligibility against cached channels, reject `channel_not_eligible` otherwise → insert `topup_transactions` row `status='pending'` with `fingerprint_hash`, `ip`, `expiry_minutes` (from vars/default 30) → call `DompetxClient.createInvoice` → `UPDATE topup_transactions SET invoice_id, provider_reference, checkout_url` → return `{invoice_id, checkout_url, expires_at, amount, fee, gross_amount}`; on DompetX failure mark the pending row `cancelled` and return 502
    - `GET /user_api/wallet/ledger` and `GET /user_api/topup/history` enforce `limit ≤ 100`, support cursor pagination ordered by `created_at DESC`, and accept optional `status` filter on history
    - `GET /user_api/billing/domains` returns `[{domain, domain_suffix, credit_cost}]` where `credit_cost = Pricing_Engine.resolve('create_address', domain)` for every row in `allowed_domains WHERE is_active=1`
    - All handlers map errors to the i18n message keys registered in task 1.3 and honour the `x-lang` header (falls back to `en`)
    - _Requirements: 1.5, 1.6, 2.1, 2.3, 2.5, 2.6, 2.7, 3.1, 3.2, 3.5, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 8.1, 8.2, 10.1, 10.2, 10.5, 11.5, 17.2_

  - [x] 7.2 Register billing routes in `worker/src/user_api/index.ts`
    - Import the `billing` Hono app from `worker/src/user_api/billing.ts` and mount with `app.route('/', billing)` immediately after the existing `/user_api/*` middleware so JWT authentication is applied uniformly
    - Assert registration order does not break `/user_api/login`, `/user_api/register`, `/user_api/passkey/*`, `/user_api/oauth2/*` (those routes must remain publicly accessible)
    - _Requirements: 1.1, 1.4, 1.5, 14.6_

  - [~] 7.3 Write property test for user Billing_API: Property 11 (domain preview matches Pricing_Engine)
    - Create `worker/src/user_api/__tests__/billing.property.test.ts` with `// Feature: saas-topup-billing, Property 11: Domain preview matches Pricing_Engine`
    - Generator randomises the active `allowed_domains` + `pricing_rules` state and calls `GET /user_api/billing/domains` via a Hono test client
    - Assert every returned entry has `domain ∈ active allowed_domains` and `credit_cost == Pricing_Engine.resolve('create_address', entry.domain)` (reuse the engine from task 2.1 as oracle)
    - **Property 11: Domain preview matches Pricing_Engine**
    - **Validates: Requirements 2.1, 2.4**

  - [~] 7.4 Write property test for user Billing_API: Property 14 (min top-up guard short-circuits DompetX)
    - Append describe block: `// Feature: saas-topup-billing, Property 14: Minimum top-up guard short-circuits DompetX`
    - Generator randomises `nominal ∈ ℤ` and `min_topup_idr ∈ ℤ⁺` and targets both `POST /user_api/topup/quote` and `POST /user_api/topup/create`; inject a DompetxClient spy
    - Assert: (a) for every `nominal < min_topup_idr` response is HTTP 400 `nominal_below_minimum` and `dompetxSpy.callCount === 0`; (b) the boundary value `nominal === min_topup_idr` is accepted
    - **Property 14: Minimum top-up guard short-circuits DompetX**
    - **Validates: Requirements 4.3, 19.4**

  - [~] 7.5 Write property test for user Billing_API: Property 17 (top-up create persistence and eligibility)
    - Append describe block: `// Feature: saas-topup-billing, Property 17: Top-up create persistence and eligibility`
    - Generator randomises `(nominal, channel_code)` against a random cached channel set
    - For eligible pairs assert the `topup_transactions` row is persisted with `status='pending'`, correct `amount/fee/gross_amount/channel_code/raw_payload`, and the response includes a `checkout_url`; for non-eligible pairs assert HTTP 400 `channel_not_eligible` and zero row inserts
    - **Property 17: Top-up create persistence and eligibility**
    - **Validates: Requirements 4.6, 4.9**

  - [~] 7.6 Write property test for user Billing_API: Property 25 (pagination and ordering)
    - Append describe block: `// Feature: saas-topup-billing, Property 25: Pagination and ordering`
    - Generator inserts random ledger / topup rows across random users and paginates `GET /user_api/wallet/ledger` and `GET /user_api/topup/history` with arbitrary `limit ∈ [1..150]`
    - Assert every page is sorted `created_at DESC`, `length <= min(limit, 100)`, following the `next_cursor` yields the next older window with no duplicates or gaps, and the full concatenation equals the ground-truth ordered list
    - **Property 25: Pagination and ordering**
    - **Validates: Requirements 3.2, 8.1**

- [x] 8. Payment_Webhook
  - [x] 8.1 Implement Payment_Webhook at `worker/src/open_api/payment_webhook.ts`
    - Route `POST /open_api/payment/webhook/dompetx` with no auth middleware
    - Read raw body once, validate `X-DompetX-Timestamp` within ±300s, verify `X-DompetX-Signature` via `DompetxClient.verifyWebhookSignature` (constant-time); on mismatch return 401 and increment an in-memory webhook-mismatch counter used by KPI
    - Mask `signature`, `api_key` keys in the payload before persisting `raw_payload`
    - On `status='paid'`: run D1 batch `UPDATE topup_transactions SET status='paid', paid_at, provider_reference=COALESCE(...), raw_payload=? WHERE invoice_id=? AND status='pending'`; when `rows_affected==1` invoke `Wallet_Service.creditTopup({userId, amountIdr, creditIdrRate, bonusThresholdIdr, bonusRatePercent, invoiceId})`; when `rows_affected==0` check current status and return 200 (idempotent replay / out-of-order)
    - On `status='failed'` / `status='expired'`: conditional update from `pending` and always return 200
    - Handle `UNIQUE(idempotency_key, type)` violation from `creditTopup` by returning 200 (replay is a no-op)
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 11.1, 11.2, 11.6, 15.4_

  - [x] 8.2 Wire webhook + open_api routes in `worker/src/worker.ts`
    - Register the Payment_Webhook route under `/open_api/*` so the existing no-auth rule covers it
    - Confirm no regression to existing `/open_api/auth.ts` routes
    - _Requirements: 5.1_

  - [x] 8.3 Write property test for Payment_Webhook: Property 18 (signature verification)
    - Create `worker/src/open_api/__tests__/payment_webhook.property.test.ts` with `// Feature: saas-topup-billing, Property 18: Webhook signature verification`
    - Generator produces valid `(body, timestamp)` pairs and random single-byte tamper positions; sign the valid pair with the correct secret
    - Assert the valid request returns any status other than 401 and the tampered variant always returns 401 with zero mutations (`topup_transactions`, `credit_ledger`, `wallets` all unchanged)
    - **Property 18: Webhook signature verification**
    - **Validates: Requirements 5.2, 5.3**

  - [x] 8.4 Write property test for Payment_Webhook: Property 19 (`paid` state transition)
    - Append describe block: `// Feature: saas-topup-billing, Property 19: Webhook paid state transition`
    - Generator produces random `(amount, credit_idr_rate, bonus_threshold_idr, bonus_rate_percent, invoice_id)`; seed a matching `pending` row; deliver a valid signed webhook
    - Assert after processing: row `status='paid'`, a single TOPUP ledger row with `credit_delta = floor(amount / credit_idr_rate)` and `idempotency_key = invoice_id`, optional BONUS row when threshold reached, `wallets.balance_credit` increments by the total
    - **Property 19: Webhook `paid` state transition**
    - **Validates: Requirements 5.4**

  - [x] 8.5 Write property test for Payment_Webhook: Property 20 (idempotency across replays)
    - Append describe block: `// Feature: saas-topup-billing, Property 20: Webhook idempotency across replays`
    - Generator delivers N ≥ 1 identical signed webhooks for the same `invoice_id` with `status='paid'`, interleaved arbitrarily with a simulated reconciler-triggered `creditTopup` on the same invoice
    - Assert exactly one TOPUP and at most one BONUS ledger row exist with that `idempotency_key`; wallet balance increment equals the single-delivery amount; every delivery returns HTTP 200
    - **Property 20: Webhook idempotency across replays**
    - **Validates: Requirements 5.5, 5.9, 8.5, 11.6, 19.2**

  - [x] 8.6 Write property test for Payment_Webhook: Property 21 (terminal non-paid transitions)
    - Append describe block: `// Feature: saas-topup-billing, Property 21: Webhook terminal non-paid transitions`
    - Generator delivers signed webhooks with `status ∈ {failed, expired}` against rows in `pending` and rows already in `failed/expired/paid`
    - Assert pending → matching terminal status, no ledger row, wallet unchanged; already-terminal rows: no mutation, response 200
    - **Property 21: Webhook terminal non-paid transitions**
    - **Validates: Requirements 5.6, 5.7**

  - [x] 8.7 Write property test for Payment_Webhook: Property 22 (`raw_payload` masking)
    - Append describe block: `// Feature: saas-topup-billing, Property 22: raw_payload masking on persistence`
    - Generator produces arbitrary JSON payloads including `signature` and `api_key` fields at random nesting depths
    - Assert the persisted `raw_payload` is non-null and its parsed JSON has every `signature`/`api_key` field either omitted or replaced with `"***"` (recursive check); original values MUST NOT appear anywhere in the stored string
    - **Property 22: raw_payload masking on persistence**
    - **Validates: Requirements 5.10, 15.4**

- [ ] 9. Public payment channels endpoint
  - [x] 9.1 Implement `GET /open_api/payment_channels` at `worker/src/open_api/payment_channels.ts`
    - No auth; delegate to `Channel_Cache.listPublic(nominal)`; omit sensitive fields
    - Register under `/open_api/*` in `worker/src/worker.ts` alongside the webhook route
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5_

- [~] 10. Checkpoint — first billing backend milestone
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 11. Paid-action integration and grandfather policy
  - [x] 11.1 Integrate `create_address` debit path
    - In the existing handler that serves address creation (`worker/src/user_api/user_mail_api.ts` or the corresponding `/api/new_address` route), before creating the address: require fingerprint, validate domain ∈ `allowed_domains WHERE is_active=1` (400 `domain_not_allowed`), compute `required_credit = Pricing_Engine.resolve('create_address', domain)`, run `Wallet_Service.debit` with `{action_key:'create_address', domain, resource_id: newAddressId}` AFTER the address row is inserted but in the same batch so rollback is atomic
    - If address creation fails after debit, call `Wallet_Service.refund` with `refund_of = debit.ledgerId` and propagate the upstream error
    - Respect grandfather helper (task 11.4) when deciding whether to debit
    - _Requirements: 2.4, 2.5, 2.6, 2.7, 6.1, 6.2, 6.3, 6.6, 6.7, 13.3, 14.1, 14.3_

  - [x] 11.2 Integrate `send_mail` debit path
    - In every handler that performs user-triggered mail sending (user-facing `send_mail`, admin-triggered variants if they charge the user), compute `required_credit = Pricing_Engine.resolve('send_mail', domain)`, run `Wallet_Service.debit` before invoking the external SMTP/send route
    - On external failure call `Wallet_Service.refund` with `refund_of = debit.ledgerId` and return 502 `external_unavailable`
    - Grandfather policy: `send_mail` is always charged (even for grandfathered addresses) per Requirement 14.2
    - _Requirements: 6.1, 6.2, 6.3, 6.6, 6.7, 14.2_

  - [x] 11.3 Integrate `forward_mail` debit path in the Email Worker
    - In `worker/src/email/index.ts` forward branch, before invoking Cloudflare Email Routing forward, call `Pricing_Engine.resolve('forward_mail', recipientDomain)` + `Wallet_Service.debit` against the address owner
    - On external failure call `Wallet_Service.refund`; on insufficient credit skip the forward and log an event without charging
    - Do NOT add billing to the receive pipeline (parse/junk/exists/auto-reply/webhook/store remain free) per Requirement 13.4
    - Grandfather: `forward_mail` is always charged per Requirement 14.2
    - _Requirements: 6.1, 6.2, 6.3, 6.6, 6.7, 13.1, 13.4, 14.2_

  - [x] 11.4 Implement grandfather policy helper at `worker/src/billing/grandfather.ts`
    - Export `isGrandfathered({addressCreatedAt, now, billingLaunchAt, grandfatherPeriodDays})` returning boolean per Requirement 14 rules
    - Export `shouldChargeDebit({action, addressCreatedAt, now, billingLaunchAt, grandfatherPeriodDays})`:
      - address created after `billing_launch_at` → always charge
      - address created before `billing_launch_at` and `now < billing_launch_at + grandfather_period_days` and action ∈ routine set → skip charge
      - action ∈ {send_mail, forward_mail} → always charge
      - after grandfather window expires → always charge
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5_

  - [~] 11.5 Write property test for paid-action integration: Property 12 (insufficient-credit rejection)
    - Create `worker/src/billing/__tests__/paid_action.property.test.ts` with `// Feature: saas-topup-billing, Property 12: Insufficient-credit rejection`
    - Generator randomises `(balance_credit, required_credit, action, domain)` with `balance_credit < required_credit` cases; drive the integrated `/api/new_address` route
    - Assert response is HTTP 402 `insufficient_credit` exclusively, no `credit_ledger` row is inserted, `wallets.balance_credit` unchanged, and no address row is inserted
    - **Property 12: Insufficient-credit rejection**
    - **Validates: Requirements 2.5, 2.7, 6.3**

  - [~] 11.6 Write property test for paid-action integration: Property 13 (disallowed-domain rejection)
    - Append describe block: `// Feature: saas-topup-billing, Property 13: Disallowed-domain rejection`
    - Generator produces random domain strings including some NOT in `allowed_domains WHERE is_active=1`
    - Assert response is HTTP 400 `domain_not_allowed` exclusively; no wallet / ledger / address mutation
    - **Property 13: Disallowed-domain rejection**
    - **Validates: Requirements 2.6, 2.7, 13.3**

  - [~] 11.7 Write property test for paid-action integration: Property 33 (grandfather policy)
    - Append describe block: `// Feature: saas-topup-billing, Property 33: Grandfather policy`
    - Generator randomises `(addressCreatedAt, now, billingLaunchAt, grandfatherPeriodDays, action ∈ {create_address, send_mail, forward_mail, list_mails, read_mail})`
    - Assert `shouldChargeDebit` matches the decision matrix from Requirement 14.1–14.5 and that integrated handlers actually skip debit when `shouldChargeDebit` returns false
    - **Property 33: Grandfather policy**
    - **Validates: Requirements 14.1, 14.2, 14.3, 14.5**

- [ ] 12. Billing_Admin_API
  - [x] 12.1 Implement admin `pricing_rules` endpoints at `worker/src/admin_api/billing_admin.ts`
    - `GET /admin/billing/pricing_rules` — return all `rule_key` rows with their active + historical versions
    - `PUT /admin/billing/pricing_rules` — body `{rule_key, rule_value_json}`; validate: `domain_weight_com ∈ [1,5]` else 400 `margin_guard_violation`; `min_topup_idr >= 10000` else 400 `min_topup_violation`; `credit_idr_rate >= 1` integer; `bonus_rate_percent ∈ [0,100]`
    - Single D1 batch: `UPDATE pricing_rules SET is_active=0 WHERE rule_key=? AND is_active=1` → `INSERT INTO pricing_rules(rule_key, rule_value_json, version=(SELECT COALESCE(MAX(version),0)+1 FROM pricing_rules WHERE rule_key=?), is_active=1)` → `INSERT INTO billing_audit_logs(admin_id, event_type='pricing_update', rule_key, old_value, new_value, created_at)` → call `Pricing_Engine.invalidateCache()`
    - _Requirements: 7.1, 7.3, 7.4, 7.5, 7.6, 7.7, 9.6_

  - [x] 12.2 Implement admin topup transactions endpoints in `billing_admin.ts`
    - `GET /admin/billing/topup_transactions?status=&user_id=&from=&to=&limit=&cursor=` — paged list with optional filters, `limit <= 100`, cursor on `(created_at, id)`
    - `GET /admin/billing/topup_transactions/:id` — returns the full row INCLUDING `raw_payload`
    - _Requirements: 9.2, 15.5_

  - [x] 12.3 Implement admin channels refresh endpoint in `billing_admin.ts`
    - `POST /admin/billing/channels/refresh` — synchronously call `Channel_Cache.refresh()`; return `{count, fetched_at}`; write `billing_audit_logs` row with `event_type='channel_refresh'`
    - _Requirements: 9.1, 16.5_

  - [x] 12.4 Implement admin credit adjust endpoint in `billing_admin.ts`
    - `POST /admin/billing/credit_adjust` — body `{user_id, credit_delta, reason}`; delegate to `Wallet_Service.adjust`; when the resulting balance would be < 0 respond HTTP 400 `negative_balance_not_allowed` and write nothing
    - In the same D1 batch as the ADJUST ledger row, write `billing_audit_logs` with `event_type='credit_adjust'`, `admin_id`, `target_user_id`, `credit_delta`, `reason`
    - _Requirements: 9.3, 9.4, 9.5, 9.6_

  - [x] 12.5 Implement admin KPI endpoint in `billing_admin.ts`
    - `GET /admin/billing/kpi?from=&to=` — compute `payment_success_rate = paid / (paid + failed + expired)`, `webhook_mismatch_rate = invalid_sig_count / total_webhooks`, `pending_over_30min_rate`, `net_margin_idr`, `refund_dispute_rate` via SQL aggregates on `topup_transactions` + `credit_ledger` + webhook counter store
    - Reject non-admin (middleware already handles this) with HTTP 401/403
    - _Requirements: 12.1, 12.2, 12.4, 12.5_

  - [x] 12.6 Implement admin domains endpoints in `billing_admin.ts`
    - `GET /admin/billing/domains`, `POST /admin/billing/domains` (body `{domain}` — verify the domain is active in Cloudflare Email Routing via `CLOUDFLARE_EMAIL_ROUTING_TOKEN` before inserting), `DELETE /admin/billing/domains/:domain`
    - Write `billing_audit_logs` row with `event_type='domain_add'` / `domain_remove`
    - _Requirements: 13.3, 13.5_

  - [x] 12.7 Register admin billing routes in `worker/src/admin_api/index.ts`
    - Mount the `billing_admin` Hono app so it inherits the existing `/admin/*` `x-admin-auth` middleware; do not modify or relocate existing admin routes
    - _Requirements: 9.6, 12.4_

  - [~] 12.8 Write property test for Admin API: Property 9 (active-version selection + atomic update)
    - Create `worker/src/admin_api/__tests__/billing_admin.property.test.ts` with `// Feature: saas-topup-billing, Property 9: Active-version selection and atomic update`
    - Generator applies random sequences of `PUT /admin/billing/pricing_rules` for arbitrary `rule_key`s with arbitrary version histories
    - Assert after every commit: exactly one `is_active=1` row per `rule_key`, `version` strictly increases, and exactly one matching `billing_audit_logs` row with `event_type='pricing_update'` exists; Pricing_Engine reads only the active-max-version row
    - **Property 9: Active-version selection and atomic update**
    - **Validates: Requirements 7.6, 7.7**

  - [~] 12.9 Write property test for Admin API: Property 10 (pricing-rule admin validation)
    - Append describe block: `// Feature: saas-topup-billing, Property 10: Pricing-rule admin validation`
    - Generator produces PUT requests with random `(rule_key, value)`; cover boundary values `domain_weight_com ∈ {0,1,5,6,100}` and `min_topup_idr ∈ {0, 9999, 10000, 50000}`
    - Assert `domain_weight_com>5` → 400 `margin_guard_violation`, zero inserts; `min_topup_idr<10000` → 400 `min_topup_violation`, zero inserts; boundary-valid values succeed
    - **Property 10: Pricing-rule admin validation**
    - **Validates: Requirements 7.4, 7.5**

  - [~] 12.10 Write property test for Admin API: Property 26 (admin transactions filter correctness)
    - Append describe block: `// Feature: saas-topup-billing, Property 26: Admin transactions filter correctness`
    - Generator inserts random `topup_transactions` rows across multiple users/statuses/dates and issues random filter combinations
    - Assert every returned row simultaneously satisfies every provided predicate; an unfiltered call is bounded only by authorization and limit
    - **Property 26: Admin transactions filter correctness**
    - **Validates: Requirements 9.2**

  - [~] 12.11 Write property test for Admin API: Property 27 (credit adjust ledger + audit)
    - Append describe block: `// Feature: saas-topup-billing, Property 27: Credit adjust ledger and audit`
    - Generator produces random `credit_delta ∈ ℤ` that does not violate Property 2
    - Assert exactly one ADJUST ledger row with the requested delta, `wallets.balance_credit` changes by `credit_delta`, and one matching `billing_audit_logs` row (`event_type='credit_adjust'`, `admin_id`, `target_user_id`, `credit_delta`, `reason`) is written in the same batch
    - **Property 27: Credit adjust ledger and audit**
    - **Validates: Requirements 9.3, 9.5**

  - [~] 12.12 Write property test for Admin API: Property 31 (KPI aggregate correctness)
    - Append describe block: `// Feature: saas-topup-billing, Property 31: KPI aggregate correctness`
    - Generator randomises `topup_transactions` rows and webhook-event counters within arbitrary `[from, to]` windows
    - Assert `payment_success_rate == paid / (paid + failed + expired)` and `webhook_mismatch_rate == invalid_signature_count / total_received` computed by the endpoint match pure-function oracles computed directly from the raw rows
    - **Property 31: KPI aggregate correctness**
    - **Validates: Requirements 12.2, 12.5**

- [ ] 13. Topup_Reconciler, auto margin guard, and scheduled hook
  - [x] 13.1 Implement `Topup_Reconciler` at `worker/src/billing/reconciler.ts`
    - Implement `runReconcile(env, ctx)`: select up to 100 `topup_transactions WHERE status='pending' AND created_at < datetime('now', '-' || expiry_minutes || ' minutes')`; for each, call `DompetxClient.getInvoiceStatus(invoice_id)`
    - Map provider status → `paid` invokes `Wallet_Service.creditTopup` (idempotent via `invoice_id`) and UPDATEs row `status='paid'`; `failed` / `expired` UPDATEs row; `unknown` logs and leaves row pending
    - _Requirements: 8.3, 8.4, 8.5_

  - [x] 13.2 Implement auto margin guard inside the reconciler
    - After processing pending rows, compute rolling 30-day `net_margin_monthly` from `topup_transactions` + `credit_ledger`
    - If `pricing_rules['margin_guard_auto'] = true` and `net_margin_monthly < margin_guard_target_percent`, increment `domain_weight_com` by 1 (capped at 5) via the same batched PUT flow from task 12.1 with `admin_id = null` and `event_type='auto_margin_guard'`
    - _Requirements: 12.3_

  - [x] 13.3 Wire reconciler into the scheduled handler in `worker/src/scheduled.ts`
    - On cron event (every 5 min), call `runReconcile(env, ctx)`; keep existing scheduled entries untouched so other cron workloads continue to run
    - _Requirements: 8.3, 12.3_

  - [x] 13.4 Write property test for Reconciler: Property 24 (expires + late paid)
    - Create `worker/src/billing/__tests__/reconciler.property.test.ts` with `// Feature: saas-topup-billing, Property 24: Reconciler expires pending and honors late paid`
    - Generator produces `pending` rows older than `expiry_minutes` with random provider-returned statuses
    - Assert `getInvoiceStatus` is called exactly once per row; `paid` → state converges to Property 20's post-condition (idempotent even if a webhook also arrives); `failed/expired/unknown` → correct status transition with no ledger mutation
    - **Property 24: Reconciler expires pending and honors late paid**
    - **Validates: Requirements 8.3, 8.4, 8.5**

  - [x] 13.5 Write property test for Reconciler: Property 32 (auto margin guard upper bound)
    - Append describe block: `// Feature: saas-topup-billing, Property 32: Auto margin guard upper bound`
    - Generator randomises `(net_margin_monthly, margin_guard_target_percent, current domain_weight_com, margin_guard_auto)`
    - Assert: if `margin_guard_auto=true` and `net_margin_monthly < target` and current `< 5` then weight increases by at most 1 per run and never exceeds 5, with one `event_type='auto_margin_guard'` audit row per adjustment; otherwise no change
    - **Property 32: Auto margin guard upper bound**
    - **Validates: Requirements 12.3**

  - [x] 13.6 Write property test for migration: Property 34 (migration back-fill idempotency)
    - Append describe block to `worker/src/billing/__tests__/reconciler.property.test.ts` OR create `migration.property.test.ts`: `// Feature: saas-topup-billing, Property 34: Migration back-fill`
    - Generator produces a pre-migration `users` table with N random users (N ∈ [0, 200]); apply the migration from task 1.1 either once or multiple times
    - Assert post-migration `wallets` has exactly N rows, one per user with `balance_credit=0`, `balance_idr_ref=0`; repeated migration runs do not change the row count
    - **Property 34: Migration back-fill**
    - **Validates: Requirements 14.7**

- [ ] 14. Startup validation and secret non-leakage
  - [x] 14.1 Add boot-time secret validation hook in `worker/src/worker.ts`
    - Before registering billing routes, validate presence of `DOMPETX_API_KEY`, `DOMPETX_API_SECRET`, `DOMPETX_WEBHOOK_SECRET`, `CLOUDFLARE_EMAIL_ROUTING_TOKEN`; when `BILLING_ENABLED=true` and any are missing, respond to the first billing request with an explicit i18n error and skip route registration
    - Never echo the secret values in the error; reference them by key name only
    - _Requirements: 15.1, 15.2, 15.6_

  - [x] 14.2 Write property test: Property 36 (secret non-leakage in responses)
    - Create `worker/src/billing/__tests__/secret_leakage.property.test.ts` with `// Feature: saas-topup-billing, Property 36: Secret non-leakage in responses`
    - Generator produces arbitrary requests to every `/user_api/*`, `/open_api/payment_channels`, `/user_api/topup/history`, and asserts the response body never contains the string values of `DOMPETX_API_KEY`, `DOMPETX_API_SECRET`, `DOMPETX_WEBHOOK_SECRET`, `CLOUDFLARE_EMAIL_ROUTING_TOKEN`, nor a top-level `raw_payload` field
    - Also assert `GET /admin/billing/topup_transactions/:id` is the only path that exposes `raw_payload`
    - **Property 36: Secret non-leakage in responses**
    - **Validates: Requirements 15.1, 15.5, 16.4**

- [~] 15. Checkpoint — worker-side billing complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 16. Frontend Wallet UI
  - [~] 16.1 Add billing API client and fingerprint wiring at `frontend/src/api/billing.js`
    - Wrap axios (reuse `frontend/src/api/index.js` instance) with functions for `getWallet`, `getLedger`, `getDomains`, `quoteTopup`, `createTopup`, `getTopupHistory`
    - Integrate FingerprintJS (`@fingerprintjs/fingerprintjs`) on app boot; cache the visitor id in memory (not localStorage) and attach as `x-fingerprint` header on every `/user_api/topup/*` request and every paid-action request
    - Add a global axios response interceptor that refreshes wallet store on any 402 and surfaces the i18n `insufficient_credit` message
    - _Requirements: 10.3, 10.5, 15.3_

  - [~] 16.2 Add wallet store slice at `frontend/src/store/index.js`
    - Add `wallet = { balance_credit, balance_idr_ref, updated_at }` via `useStorage` (raw string serialisation per existing pattern); actions: `refreshWallet`, `clearWallet`
    - _Requirements: 3.1_

  - [~] 16.3 Create `WalletHome.vue` at `frontend/src/views/user/wallet/WalletHome.vue`
    - Show current balance, last 10 ledger entries, a "Top-up" button routing to the Topup view
    - _Requirements: 3.1, 3.2_

  - [~] 16.4 Create `Topup.vue` at `frontend/src/views/user/wallet/Topup.vue`
    - Presets `Rp10.000`, `Rp20.000`, `Rp50.000`, `Rp100.000`, `Rp250.000` plus custom input; call `POST /user_api/topup/quote` on nominal change and render channel list with `{name, estimated_fee, gross_amount, fee_bearer}`
    - Display "Bonus +X%" tag on presets that meet the configured `bonus_threshold_idr`
    - On "Bayar Sekarang" call `POST /user_api/topup/create`, open `checkout_url` in a new tab, start a polling loop against `GET /user_api/topup/history` every 5s for up to 2 minutes or until the invoice leaves `pending`
    - _Requirements: 4.1, 4.2, 4.5, 4.6, 8.6, 11.5_

  - [~] 16.5 Create `TopupHistory.vue` at `frontend/src/views/user/wallet/TopupHistory.vue`
    - Paged list using cursor; filter by status; show `invoice_id`, `amount`, `fee`, `gross_amount`, `channel`, `status`, `created_at`, `paid_at`
    - _Requirements: 8.1, 8.2_

  - [~] 16.6 Create `Ledger.vue` at `frontend/src/views/user/wallet/Ledger.vue`
    - Cursor-paged ledger display with type, delta, idr_ref, metadata, created_at
    - _Requirements: 3.2, 3.3_

  - [x] 16.7 Add credit-cost preview on the address creation form
    - In the existing address creation view (under `frontend/src/views/`) fetch `GET /user_api/billing/domains` on mount and render `credit_cost` next to each selectable domain; disable the confirm button when `balance_credit < credit_cost`
    - _Requirements: 2.1, 2.3_

  - [~] 16.8 Wire wallet routes in `frontend/src/router/` and navigation entry
    - Register `/user/wallet`, `/user/wallet/topup`, `/user/wallet/topup/history`, `/user/wallet/ledger` as authenticated routes; add nav links in the user header/sidebar
    - _Requirements: 3.1, 4.1, 8.1_

  - [x] 16.9 Write unit test: Topup.vue preset and channel computation
    - Use `@vue/test-utils` + Vitest; mock API returning a fixed channel list; assert preset click updates `nominal`, quote panel shows correct `gross_amount`, and the "Bayar Sekarang" button is disabled for non-eligible combinations
    - _Requirements: 4.1, 4.2, 4.5_

  - [x] 16.10 Write unit test: axios interceptor auto-refreshes wallet on 402
    - Mock a paid-action API returning 402 `insufficient_credit`; assert the wallet store is refreshed and the i18n-localised toast is emitted
    - _Requirements: 2.5, 6.3_

- [ ] 17. Indonesian locale and fallback
  - [x] 17.1 Add worker i18n locale `id` at `worker/src/i18n/id.ts`
    - Translate every billing key added in task 1.3 plus all existing keys in `type.ts` into Bahasa Indonesia; register `id` in `worker/src/i18n/index.ts` and include fallback-to-`en` when a key is missing
    - _Requirements: 17.1, 17.2, 17.3_

  - [x] 17.2 Add frontend locale `id` under `frontend/src/i18n/locales/`
    - Mirror existing `en`/`zh` structure; register the locale in `frontend/src/i18n/locale-registry.ts` and `message-registry.ts`
    - _Requirements: 17.1_

  - [x] 17.3 Default locale to `id` for `automation.my.id`
    - In the worker, default `x-lang` → `id` when the request `Host` header is `automation.my.id` AND `x-lang` is absent
    - In the frontend, read the hostname at boot and set the default locale to `id` for `automation.my.id` unless a user-chosen override exists
    - _Requirements: 17.4_

  - [x] 17.4 Write property test: Property 37 (i18n fallback)
    - Create `worker/src/i18n/__tests__/i18n_fallback.property.test.ts` with `// Feature: saas-topup-billing, Property 37: i18n fallback`
    - Generator randomises `(locale ∈ {en, zh, id, fr, …}, key ∈ known_keys ∪ unknown_keys)` and deletes random keys from the chosen locale at runtime
    - Assert: when `id/zh` lack the key but `en` defines it, the message equals `en[key]`; when both are undefined, a stable sentinel (e.g., the key itself) is returned
    - **Property 37: i18n fallback**
    - **Validates: Requirements 17.3**

- [x] 18. Integration tests (mocked externals)
  - [x] 18.1 Write integration test: admin channels refresh against mocked DompetX list endpoint
    - File: `worker/src/billing/__tests__/channels_refresh.integration.test.ts`; use a fetch-mocker to return a fixed channel set; assert `payment_channels_cache` rows reflect the mock and subsequent `GET /open_api/payment_channels` returns filtered rows
    - _Requirements: 9.1, 16.5_

  - [x] 18.2 Write integration test: admin domains add against mocked Cloudflare Email Routing API
    - File: `worker/src/admin_api/__tests__/domains.integration.test.ts`; mock the Email Routing API to return success; assert `allowed_domains` row is inserted only after the mock returns 200; assert 400 when the mock returns a failure
    - _Requirements: 13.5_

  - [x] 18.3 Write integration test: scheduled cron trigger invokes reconciler
    - File: `worker/src/billing/__tests__/scheduled.integration.test.ts`; simulate a scheduled event via the Cloudflare Workers test runtime; assert `runReconcile` is called exactly once per invocation and touches expected rows
    - _Requirements: 8.3_

  - [x] 18.4 Write integration test: startup failure when billing secrets are missing
    - File: `worker/src/billing/__tests__/startup_secrets.integration.test.ts`; spin up the worker with selected secrets unset and `BILLING_ENABLED=true`; assert the first billing request returns the explicit error and that non-billing routes (`/api/*`, `/admin/*`, `/open_api/auth`) remain functional
    - _Requirements: 15.6, 14.6_

  - [x] 18.5 Write integration test: schema unique constraints on `topup_transactions`
    - File: `worker/src/billing/__tests__/schema.integration.test.ts`; directly attempt duplicate inserts on `invoice_id` and `provider_reference`; assert SQLite constraint errors; verify `CHECK (balance_credit >= 0)` rejects a manual UPDATE that would go negative
    - _Requirements: 5.8, 6.4_

- [ ] 19. E2E tests (Playwright, under `e2e/tests/api/`)
  - [x] 19.1 Write `billing-topup-happy.spec.ts`
    - Login → `POST /user_api/topup/quote` → `POST /user_api/topup/create` → simulate a signed DompetX webhook → assert balance reflects credit + bonus when nominal ≥ threshold
    - Add a mocked DompetX service container to `e2e/docker-compose.yml` and wire webhook URL to the worker under test
    - _Requirements: 4.6, 5.4, 8.1, 11.1, 18.4_

  - [x] 19.2 Write `billing-webhook-idempotency.spec.ts`
    - Deliver the same signed webhook 3 times for the same `invoice_id`; assert exactly one TOPUP and at most one BONUS ledger entry exist
    - _Requirements: 5.5, 5.9, 11.6_

  - [x] 19.3 Write `billing-insufficient-credit.spec.ts`
    - User with zero balance attempts `POST /api/new_address` on an allowed domain; assert HTTP 402 `insufficient_credit`
    - _Requirements: 2.5, 6.3_

  - [x] 19.4 Write `billing-domain-cost-preview.spec.ts`
    - Call `GET /user_api/billing/domains`; assert `.com` domains have a higher `credit_cost` than `.web.id` / `.my.id` domains under the default pricing
    - _Requirements: 2.1, 2.2_

  - [x] 19.5 Write `billing-rate-limit.spec.ts`
    - Fire 6 `POST /user_api/topup/create` within 10 minutes for the same user; assert the 6th returns HTTP 429
    - _Requirements: 10.1_

- [ ] 20. Documentation and changelog
  - [~] 20.1 Add VitePress billing feature guide (zh + en)
    - Create `vitepress-docs/docs/zh/guide/feature/billing.md` and `vitepress-docs/docs/en/guide/feature/billing.md` covering: overview, wallet + credit model, pricing rules, top-up flow, DompetX integration, admin operations, KPI, abuse guard, grandfather policy
    - _Requirements: 18.2_

  - [~] 20.2 Update `guide/worker-vars.md` (zh + en) with new environment variables
    - Add entries for `DOMPETX_API_KEY`, `DOMPETX_API_SECRET`, `DOMPETX_WEBHOOK_SECRET`, `CLOUDFLARE_EMAIL_ROUTING_TOKEN`, `BILLING_ENABLED`, `BILLING_LAUNCH_AT`, `DEFAULT_LANG`
    - _Requirements: 18.2_

  - [~] 20.3 Add VitePress API reference docs (zh + en)
    - Add pages under `vitepress-docs/docs/*/api/` documenting every user + admin + open_api billing endpoint with request / response examples and error codes
    - _Requirements: 18.3_

  - [~] 20.4 Update `CHANGELOG.md` (zh) and `CHANGELOG_EN.md` (en)
    - Under the `(main)` section add bilingual entries: `- feat: |billing| wallet service, top-up flow, DompetX integration, admin billing, Indonesian locale` plus sub-entries per subsystem following Conventional Commits
    - _Requirements: 18.1, 18.5_

- [~] 21. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP, but they are required to discharge Requirement 19 (Correctness Properties) and should be included for any release claiming production-ready billing correctness.
- Each task references specific sub-requirements from `requirements.md` for traceability.
- Property-based tests use `fast-check` with `{ numRuns: 100 }` minimum and are annotated with `// Feature: saas-topup-billing, Property N: ...` per design.md §"Testing Strategy".
- Checkpoints (tasks 10, 15, 21) exist to pause for a manual review of test outcomes and open questions before proceeding to the next major phase.
- All 37 correctness properties (P1–P37) have exactly one dedicated property-test sub-task:
  P1→3.2, P2→3.3, P3→3.4, P4→3.5, P5→3.6, P6→3.7, P7→2.2, P8→2.3, P9→12.8, P10→12.9, P11→7.3, P12→11.5, P13→11.6, P14→7.4, P15→5.2, P16→5.3, P17→7.5, P18→8.3, P19→8.4, P20→8.5, P21→8.6, P22→8.7, P23→3.8, P24→13.4, P25→7.6, P26→12.10, P27→12.11, P28→6.2, P29→6.3, P30→6.4, P31→12.12, P32→13.5, P33→11.7, P34→13.6, P35→3.9, P36→14.2, P37→17.4.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "1.4"] },
    { "id": 1, "tasks": ["2.1", "3.1", "4.1", "5.1", "6.1", "11.4", "17.1", "17.2"] },
    { "id": 2, "tasks": ["2.2", "3.2", "4.2", "5.2", "6.2", "7.1", "8.1", "9.1", "11.1", "11.2", "11.3", "12.1", "13.1", "14.1", "17.3"] },
    { "id": 3, "tasks": ["2.3", "3.3", "5.3", "6.3", "7.2", "8.2", "12.2", "13.2", "16.1", "17.4"] },
    { "id": 4, "tasks": ["3.4", "6.4", "7.3", "8.3", "12.3", "13.3", "16.2", "17.3", "18.1"] },
    { "id": 5, "tasks": ["3.5", "7.4", "8.4", "12.4", "13.4", "16.3", "18.2"] },
    { "id": 6, "tasks": ["3.6", "7.5", "8.5", "12.5", "13.5", "16.4", "18.3"] },
    { "id": 7, "tasks": ["3.7", "7.6", "8.6", "12.6", "13.6", "16.5", "18.4"] },
    { "id": 8, "tasks": ["3.8", "8.7", "12.7", "16.6", "18.5"] },
    { "id": 9, "tasks": ["3.9", "11.5", "12.8", "14.2", "16.7"] },
    { "id": 10, "tasks": ["11.6", "12.9", "16.8"] },
    { "id": 11, "tasks": ["11.7", "12.10", "16.9"] },
    { "id": 12, "tasks": ["12.11", "16.10"] },
    { "id": 13, "tasks": ["12.12", "19.1"] },
    { "id": 14, "tasks": ["19.2"] },
    { "id": 15, "tasks": ["19.3"] },
    { "id": 16, "tasks": ["19.4"] },
    { "id": 17, "tasks": ["19.5"] },
    { "id": 18, "tasks": ["20.1", "20.2", "20.3", "20.4"] }
  ]
}
```







