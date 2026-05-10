# 计费（钱包与充值）

项目已支持基于信用点的钱包计费流程。

## 功能概览

- 每个用户都有钱包（`/user_api/wallet`）
- 付费动作会扣减 credit
- 用户可通过支付渠道进行 IDR 充值
- 支付回调与定时对账共同保证订单状态最终一致

## 用户接口

- `GET /user_api/wallet`
- `GET /user_api/wallet/ledger`
- `GET /user_api/billing/domains`
- `POST /user_api/topup/quote`
- `POST /user_api/topup/create`
- `GET /user_api/topup/history`

## 公开接口

- `GET /open_api/payment_channels`
- `POST /open_api/payment/webhook/dompetx`

## 管理接口

- `GET /admin/billing/pricing_rules`
- `PUT /admin/billing/pricing_rules`

## 说明

- 通过 `BILLING_ENABLED=true` 开启计费
- 生产环境必须先配置 DompetX 相关 secrets
- 定时 reconciler 会处理 pending/expired 订单收敛

