/**
 * Billing TypeScript models and shared type definitions
 * Feature: saas-topup-billing
 * Requirements: 3.3, 5.4, 15.1, 15.2
 */

// ─── Ledger ──────────────────────────────────────────────────────────────────

export type LedgerType = 'TOPUP' | 'DEBIT' | 'ADJUST' | 'BONUS' | 'REFUND';

export interface LedgerMetadata {
    action_key?: string;       // for DEBIT/REFUND
    domain?: string;
    resource_id?: string | number;
    invoice_id?: string;       // for TOPUP/BONUS
    refund_of?: number;        // ledger_id of the DEBIT being refunded
    admin_id?: number;         // for ADJUST
    reason?: string;
}

export interface LedgerEntry {
    id: number;
    user_id: number;
    type: LedgerType;
    credit_delta: number;
    idr_ref: number | null;
    metadata: LedgerMetadata | null;
    idempotency_key: string | null;
    created_at: string;
}

export interface LedgerPage {
    items: LedgerEntry[];
    next_cursor: string | null;
}

// ─── Wallet ───────────────────────────────────────────────────────────────────

export interface WalletRow {
    user_id: number;
    balance_credit: number;
    balance_idr_ref: number;
    created_at: string;
    updated_at: string;
}

// ─── Top-up transactions ──────────────────────────────────────────────────────

export type TopupStatus = 'pending' | 'paid' | 'failed' | 'expired' | 'cancelled';

export interface TopupRow {
    id: number;
    user_id: number;
    invoice_id: string;
    provider_reference: string | null;
    channel_code: string;
    amount: number;
    fee: number;
    gross_amount: number;
    fee_bearer: 'customer' | 'merchant';
    status: TopupStatus;
    checkout_url: string | null;
    expiry_minutes: number;
    fingerprint_hash: string | null;
    ip: string | null;
    raw_payload: string | null;
    created_at: string;
    paid_at: string | null;
    updated_at: string;
}

// ─── Pricing rules ────────────────────────────────────────────────────────────

export interface PricingRuleRow {
    id: number;
    rule_key: string;
    rule_value_json: string;   // JSON-encoded value, typed per rule_key
    version: number;
    is_active: boolean;
    created_at: string;
}

// ─── Allowed domains ──────────────────────────────────────────────────────────

export interface AllowedDomainRow {
    domain: string;
    is_active: boolean;
    created_at: string;
    created_by: number | null;
}

// ─── Payment channels ─────────────────────────────────────────────────────────

export interface PaymentChannel {
    channel_code: string;
    name: string;
    group: string;
    min: number;
    max: number | null;
    fee_type: 'percentage' | 'fixed' | 'mixed';
    fee_value: number;
    fee_fixed: number;
    fee_bearer: 'customer' | 'merchant';
    is_active: boolean;
    icon_url?: string;
}

export interface PaymentChannelQuote extends PaymentChannel {
    estimated_fee: number;   // in IDR
    gross_amount: number;    // nominal + fee if fee_bearer == 'customer', else nominal
    bonus_hint?: boolean;    // true when nominal >= bonus_threshold_idr
}

// ─── Pricing_Engine RuleKey ───────────────────────────────────────────────────

export type RuleKey =
    | 'domain_weight_com'
    | 'domain_weight_default'
    | 'action_cost_create_address'
    | 'action_cost_send_mail'
    | 'action_cost_forward_mail'
    | 'credit_idr_rate'
    | 'bonus_threshold_idr'
    | 'bonus_rate_percent'
    | 'min_topup_idr'
    | 'margin_guard_auto'
    | 'margin_guard_target_percent'
    | 'grandfather_period_days';

// ─── Billing error codes ──────────────────────────────────────────────────────

export type BillingErrorCode =
    | 'unauthenticated'
    | 'insufficient_credit'
    | 'domain_not_allowed'
    | 'nominal_below_minimum'
    | 'channel_not_eligible'
    | 'fingerprint_required'
    | 'rate_limited'
    | 'duplicate_invoice'
    | 'margin_guard_violation'
    | 'min_topup_violation'
    | 'negative_balance_not_allowed'
    | 'unknown_action'
    | 'invalid_webhook_signature'
    | 'invoice_not_found'
    | 'dompetx_unavailable'
    | 'rate_limit_unavailable';

// ─── Audit log ────────────────────────────────────────────────────────────────

export type AuditEventType =
    | 'pricing_update'
    | 'credit_adjust'
    | 'channel_refresh'
    | 'auto_margin_guard'
    | 'ip_block'
    | 'webhook_invalid_signature'
    | 'domain_add'
    | 'domain_remove';

export interface BillingAuditLogRow {
    id: number;
    admin_id: number | null;
    event_type: AuditEventType;
    target_user_id: number | null;
    rule_key: string | null;
    old_value: string | null;
    new_value: string | null;
    reason: string | null;
    metadata: string | null;
    created_at: string;
}

// ─── Runtime validation arrays (const) ───────────────────────────────────────

/**
 * All valid ledger entry types. Use for runtime validation of DB rows.
 */
export const BILLING_LEDGER_TYPES: readonly LedgerType[] = [
    'TOPUP',
    'DEBIT',
    'ADJUST',
    'BONUS',
    'REFUND',
] as const;

/**
 * All valid top-up transaction statuses. Use for runtime validation of DB rows.
 */
export const BILLING_TOPUP_STATUSES: readonly TopupStatus[] = [
    'pending',
    'paid',
    'failed',
    'expired',
    'cancelled',
] as const;

/**
 * All valid billing error codes. Use for runtime validation and i18n key lookup.
 */
export const BILLING_ERROR_CODES: readonly BillingErrorCode[] = [
    'unauthenticated',
    'insufficient_credit',
    'domain_not_allowed',
    'nominal_below_minimum',
    'channel_not_eligible',
    'fingerprint_required',
    'rate_limited',
    'duplicate_invoice',
    'margin_guard_violation',
    'min_topup_violation',
    'negative_balance_not_allowed',
    'unknown_action',
    'invalid_webhook_signature',
    'invoice_not_found',
    'dompetx_unavailable',
    'rate_limit_unavailable',
] as const;

/**
 * All valid pricing rule keys. Use for runtime validation of admin PUT requests.
 */
export const BILLING_RULE_KEYS: readonly RuleKey[] = [
    'domain_weight_com',
    'domain_weight_default',
    'action_cost_create_address',
    'action_cost_send_mail',
    'action_cost_forward_mail',
    'credit_idr_rate',
    'bonus_threshold_idr',
    'bonus_rate_percent',
    'min_topup_idr',
    'margin_guard_auto',
    'margin_guard_target_percent',
    'grandfather_period_days',
] as const;
