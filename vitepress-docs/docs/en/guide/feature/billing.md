# Billing (Wallet & Top-up)

This project includes a wallet-credit billing flow for SaaS usage.

## Overview

- Every user has a wallet (`/user_api/wallet`)
- Paid actions consume credits
- Users can top up IDR via payment channels
- Payment webhook + scheduled reconciler keep invoice status consistent

## User APIs

- `GET /user_api/wallet`
- `GET /user_api/wallet/ledger`
- `GET /user_api/billing/domains`
- `POST /user_api/topup/quote`
- `POST /user_api/topup/create`
- `GET /user_api/topup/history`

## Public APIs

- `GET /open_api/payment_channels`
- `POST /open_api/payment/webhook/dompetx`

## Admin APIs

- `GET /admin/billing/pricing_rules`
- `PUT /admin/billing/pricing_rules`

## Notes

- Enable billing with `BILLING_ENABLED=true`
- Configure required DompetX secrets before production traffic
- Reconciler runs on cron to finalize expired/pending invoices

