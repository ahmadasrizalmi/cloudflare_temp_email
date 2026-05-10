# Requirements Document

## Introduction

Dokumen ini mendefinisikan kebutuhan untuk mengubah produk `cloudflare_temp_email` menjadi SaaS berbasis saldo kredit (top-up) di domain `automation.my.id`. Pengguna melakukan top-up nominal rupiah melalui agregator pembayaran DompetX, lalu saldo dikonversi ke kredit internal (`1 credit = Rp100`). Setiap aksi berbayar (membuat alamat temp, kirim email, forward, dll.) mendebet kredit sesuai aturan pricing yang bergantung pada TLD domain pemilik alamat (misal `.com` lebih mahal dibanding non-`.com`) dan tipe aksi.

Tujuan utama:

- Menyediakan wallet per-user dengan ledger kredit yang bisa diaudit.
- Menyediakan alur top-up yang aman, idempoten, dan sesuai min `Rp10.000`.
- Menyediakan pricing dinamis per-domain dan per-aksi yang bisa dikonfigurasi admin tanpa redeploy.
- Tidak meregresi perilaku eksisting (user account, address, admin, Email Routing, WebAuthn, OAuth2, i18n `en`/`zh`).
- Menambahkan dukungan bahasa `id` (Bahasa Indonesia) sebagai extension dari i18n yang sudah ada.

Fitur ini berbasis Cloudflare Workers (Hono) + D1 + Vue 3, tetap mengikuti struktur `worker/src/user_api/`, `worker/src/admin_api/`, `worker/src/open_api/`, dan `frontend/src/`.

## Glossary

- **Wallet**: Entitas per-user yang menyimpan saldo kredit (`balance_credit`) dan referensi nominal terakhir (`balance_idr_ref`). Satu user memiliki tepat satu wallet.
- **Credit**: Unit pemakaian internal. `1 credit = Rp100`. Semua aksi berbayar didebet dalam satuan credit.
- **Ledger**: Catatan append-only setiap mutasi kredit (`credit_ledger`) berisi `type` (`TOPUP`, `DEBIT`, `ADJUST`, `BONUS`, `REFUND`), `credit_delta`, `idr_ref`, `metadata`, `created_at`.
- **Topup**: Transaksi pembelian kredit oleh user. Memiliki `status` ∈ {`pending`, `paid`, `failed`, `expired`, `cancelled`}.
- **Channel**: Metode pembayaran yang ditawarkan DompetX (contoh: `QRIS`, `BCA`, `BRI`). Punya `min`, `max`, `fee_type` (`percentage`/`fixed`/`mixed`), `fee_value`, `fee_fixed`, `is_active`.
- **Gross Amount**: Total nominal yang dibayar user di checkout (termasuk fee jika toggle "fee to customer" aktif).
- **Fee**: Biaya yang dikenakan channel pembayaran; bisa ditanggung customer atau merchant.
- **Idempotency Key**: Kombinasi `invoice_id` dan/atau `provider_reference` DompetX yang dipakai untuk memastikan webhook tidak pernah mengkreditkan lebih dari sekali.
- **Pricing Rule**: Aturan pricing versioned yang disimpan di tabel `pricing_rules` (format `rule_key` + `rule_value_json`), berlaku tanpa redeploy.
- **Domain Weight**: Multiplier kredit berdasarkan TLD domain (`.com` = 4, default non-`.com` = 1), dapat diadjust admin dalam batas guard (`.com` max 5).
- **High-cost Action**: Aksi yang memerlukan credit terpisah dari domain weight, contoh `send_mail`, `forward_mail`.
- **Action**: Operasi berbayar yang dilakukan user, diidentifikasi oleh `action_key` (mis. `create_address`, `send_mail`, `forward_mail`).
- **Bonus Threshold**: Nominal top-up minimum agar berhak mendapat bonus promo (default `Rp100.000`).
- **Bonus Rate**: Persentase bonus kredit dari nominal top-up (default `5%`).
- **Margin Guard**: Mekanisme otomatis admin untuk menaikkan domain weight `.com` sampai 5 kredit ketika net margin bulanan turun di bawah target.
- **Fingerprint**: Device/browser fingerprint yang di-hash, dikirim oleh frontend untuk deteksi abuse.
- **System_Name**:
  - **Wallet_Service**: Modul backend yang mengelola saldo dan ledger.
  - **Billing_API**: Modul `worker/src/user_api/billing.ts` untuk endpoint user.
  - **Billing_Admin_API**: Modul `worker/src/admin_api/billing_admin.ts` untuk endpoint admin.
  - **Payment_Webhook**: Handler public `POST /open_api/payment/webhook/dompetx`.
  - **Pricing_Engine**: Komponen yang menghitung biaya kredit berdasarkan `pricing_rules` + domain + action.
  - **Channel_Cache**: Cache `payment_channels_cache` untuk daftar channel DompetX.
  - **Frontend_Wallet_UI**: Halaman wallet/top-up di aplikasi Vue.
  - **Topup_Reconciler**: Job batch untuk menyinkronkan status `pending` yang expired.
  - **Abuse_Guard**: Rate limit + fingerprint + IP check pada endpoint sensitif billing.
  - **Audit_Log**: Log admin action pada `pricing_rules`, manual credit adjust, dan channel cache refresh.

## Requirements

### Requirement 1: Registrasi dan Onboarding SaaS di automation.my.id

**User Story:** Sebagai calon pengguna SaaS, saya ingin bisa register/login seperti sebelumnya di `automation.my.id` dan otomatis punya wallet, sehingga saya dapat langsung mengakses fitur berbayar.

#### Acceptance Criteria

1. THE Billing_API SHALL menggunakan header autentikasi eksisting `x-user-token` (JWT user) sesuai middleware di `worker/src/worker.ts`.
2. WHEN user baru berhasil register via `POST /user_api/register`, THE Wallet_Service SHALL membuat satu record `wallets` dengan `balance_credit = 0` dan `balance_idr_ref = 0`.
3. WHEN user eksisting (dibuat sebelum fitur billing dirilis) melakukan request pertama ke endpoint `/user_api/wallet`, THE Wallet_Service SHALL membuat record `wallets` secara lazy dengan `balance_credit = 0`.
4. THE Billing_API SHALL TIDAK mengubah perilaku endpoint autentikasi eksisting (`/user_api/login`, `/user_api/register`, `/user_api/passkey/*`, `/user_api/oauth2/*`).
5. THE Billing_API SHALL memvalidasi autentikasi user dengan cara yang sama seperti middleware `user_api` eksisting sebelum mengakses data wallet atau top-up.
6. IF user tidak memiliki token user yang valid, THEN THE Billing_API SHALL mengembalikan HTTP 401 dengan pesan lokal yang sesuai header `x-lang`.

### Requirement 2: Pemilihan Domain dan Preview Biaya Kredit

**User Story:** Sebagai user, saya ingin memilih domain untuk alamat temp dan melihat biaya kredit sebelum konfirmasi, sehingga saya tidak kaget saat saldo terdebet.

#### Acceptance Criteria

1. THE Billing_API SHALL menyediakan endpoint `GET /user_api/billing/domains` yang mengembalikan daftar domain aktif (contoh `automation.my.id`, `jagoseo.web.id`, `resepkue.web.id`, `resepmakanan.web.id`, `sarapanbakery.com`, `tawaf.my.id`) beserta `credit_cost` untuk action `create_address`.
2. WHEN user memanggil `GET /user_api/billing/domains`, THE Pricing_Engine SHALL menghitung `credit_cost` per-domain berdasarkan TLD dengan aturan: domain dengan suffix `.com` memakai `domain_weight_com` (default 4) dan domain lain memakai `domain_weight_default` (default 1).
3. THE Frontend_Wallet_UI SHALL menampilkan `credit_cost` di samping setiap domain pada form pembuatan alamat temp sebelum user menekan tombol konfirmasi.
4. WHEN user mengonfirmasi pembuatan alamat pada domain tertentu, THE Billing_API SHALL mendebet kredit sesuai `credit_cost` yang dikembalikan oleh Pricing_Engine untuk kombinasi (`domain`, `create_address`).
5. IF `balance_credit` user lebih kecil dari `credit_cost` yang dibutuhkan, THEN THE Billing_API SHALL menolak request dengan HTTP 402 dan kode error `insufficient_credit` dan TIDAK melakukan operasi debet apapun.
6. THE Billing_API SHALL menolak pembuatan alamat pada domain yang tidak terdaftar di daftar domain aktif dengan HTTP 400 dan kode error `domain_not_allowed`.
7. THE Billing_API SHALL menggunakan HTTP 402 secara eksklusif untuk kondisi `insufficient_credit` dan HTTP 400 secara eksklusif untuk kondisi `domain_not_allowed` (tidak dipertukarkan).

### Requirement 3: Wallet dan Riwayat Ledger

**User Story:** Sebagai user, saya ingin melihat saldo kredit dan riwayat mutasi, sehingga saya bisa mengaudit pemakaian dan top-up saya sendiri.

#### Acceptance Criteria

1. THE Billing_API SHALL menyediakan endpoint `GET /user_api/wallet` yang mengembalikan `balance_credit`, `balance_idr_ref`, dan `updated_at` milik user yang terautentikasi.
2. THE Billing_API SHALL menyediakan endpoint `GET /user_api/wallet/ledger?limit=&cursor=` yang mengembalikan halaman riwayat ledger terurut `created_at` desc dengan maksimum 100 entri per halaman.
3. THE Wallet_Service SHALL mengembalikan field `type`, `credit_delta`, `idr_ref`, `metadata`, dan `created_at` untuk setiap entri ledger.
4. THE Wallet_Service SHALL memastikan sum(`credit_delta`) seluruh baris `credit_ledger` untuk satu `user_id` sama dengan `wallets.balance_credit` user tersebut pada setiap saat konsistensi (invariant).
5. IF klien meminta ledger tanpa token user valid atau tanpa token sama sekali, THEN THE Billing_API SHALL mengembalikan HTTP 401.
6. THE Wallet_Service SHALL memperlakukan tabel `credit_ledger` sebagai append-only; modifikasi atau penghapusan baris ledger oleh alur normal SHALL ditolak.

### Requirement 4: Alur Top-up Nominal dan Channel

**User Story:** Sebagai user, saya ingin memilih nominal top-up (dengan preset) dan channel pembayaran yang valid untuk nominal itu, sehingga saya dapat menyelesaikan pembayaran dengan jelas.

#### Acceptance Criteria

1. THE Frontend_Wallet_UI SHALL menampilkan preset nominal `Rp10.000`, `Rp20.000`, `Rp50.000`, `Rp100.000`, `Rp250.000` dan input nominal custom.
2. THE Billing_API SHALL menyediakan endpoint `POST /user_api/topup/quote` yang menerima `nominal` (integer rupiah) dan mengembalikan daftar channel eligible plus `estimated_fee` per channel dan `gross_amount` per channel.
3. WHEN `nominal < 10000`, THE Billing_API SHALL menolak request `POST /user_api/topup/quote` dengan HTTP 400 dan kode `nominal_below_minimum` sebelum memanggil DompetX; nominal `nominal = 10000` SHALL diperlakukan sebagai valid (inclusive).
4. WHEN `POST /user_api/topup/quote` dipanggil dengan nominal valid, THE Channel_Cache SHALL mengembalikan hanya channel yang memenuhi `is_active = true AND nominal >= channel.min AND (channel.max IS NULL OR nominal <= channel.max)`.
5. THE Frontend_Wallet_UI SHALL menampilkan ringkasan `Nominal`, `Estimasi fee`, dan `Total bayar` per channel sebelum user klik "Bayar Sekarang".
6. WHEN user mengklik "Bayar Sekarang", THE Billing_API SHALL memanggil `POST /user_api/topup/create` dengan `nominal` dan `channel_code`, lalu membuat record `topup_transactions` berstatus `pending`, menyimpan `invoice_id`, `amount`, `fee`, `gross_amount`, `channel`, `raw_payload`, dan mengembalikan instruksi checkout DompetX.
7. WHERE toggle "fee to customer" aktif pada channel yang dipilih, THE Billing_API SHALL mencatat `gross_amount = nominal + fee` dan tetap mencatat `amount = nominal` (kredit yang akan masuk sesuai nominal, bukan gross).
8. WHERE toggle "fee to merchant" aktif pada channel yang dipilih, THE Billing_API SHALL mencatat `gross_amount = nominal` dan `fee` dihitung sebagai biaya merchant (disimpan untuk tracking margin).
9. THE Billing_API SHALL menolak `POST /user_api/topup/create` jika `channel_code` tidak eligible untuk `nominal` yang diberikan dengan HTTP 400 dan kode `channel_not_eligible`.

### Requirement 5: Webhook Pembayaran DompetX

**User Story:** Sebagai sistem, saya ingin menerima notifikasi pembayaran dari DompetX dan mengkreditkan wallet user dengan aman, sehingga saldo selalu konsisten meski webhook dikirim ulang.

#### Acceptance Criteria

1. THE Payment_Webhook SHALL mengekspos endpoint public `POST /open_api/payment/webhook/dompetx` yang tidak memerlukan header auth user/admin.
2. WHEN webhook diterima, THE Payment_Webhook SHALL memverifikasi signature request menggunakan secret yang disimpan via `wrangler secret` (`DOMPETX_WEBHOOK_SECRET`).
3. IF signature tidak valid, THEN THE Payment_Webhook SHALL mengembalikan HTTP 401 dan TIDAK mengubah state apapun.
4. WHEN signature valid dan payload menandai `status = paid`, THE Payment_Webhook SHALL mencari `topup_transactions` berdasarkan `invoice_id` dan mengubah status dari `pending` ke `paid` dalam satu transaksi D1, menulis satu entri `credit_ledger` bertipe `TOPUP` dengan `credit_delta = floor(amount / 100)`, dan meng-update `wallets.balance_credit`.
5. WHEN webhook untuk `invoice_id` yang sama diterima lebih dari sekali dengan status `paid`, THE Payment_Webhook SHALL memproses hanya transisi pertama; request berikutnya SHALL dianggap sukses (HTTP 200) tetapi TIDAK menulis entri ledger baru dan TIDAK mengubah saldo (idempotency).
6. WHEN payload menandai `status = failed`, THE Payment_Webhook SHALL mengubah status transaksi `pending` menjadi `failed` dan TIDAK mengkreditkan saldo.
7. WHEN payload menandai `status = expired`, THE Payment_Webhook SHALL mengubah status transaksi `pending` menjadi `expired` dan TIDAK mengkreditkan saldo.
8. THE Payment_Webhook SHALL menegakkan unique constraint pada (`invoice_id`) dan (`provider_reference`) di tabel `topup_transactions` sebagai lapisan pertahanan kedua terhadap duplikasi.
9. WHEN DompetX melakukan retry karena timeout, THE Payment_Webhook SHALL mengembalikan HTTP 200 untuk request yang sudah diproses sukses sebelumnya tanpa efek samping (idempotent replay).
10. THE Payment_Webhook SHALL menyimpan `raw_payload` asli pada tabel `topup_transactions` untuk keperluan audit dan reconciliation.

### Requirement 6: Konsumsi Kredit untuk Aksi Berbayar

**User Story:** Sebagai sistem, saya ingin setiap aksi berbayar mendebet kredit dengan atomik dan menolak aksi bila saldo tidak cukup, sehingga tidak pernah ada saldo negatif.

#### Acceptance Criteria

1. WHEN user memicu aksi berbayar (contoh `create_address`, `send_mail`, `forward_mail`), THE Pricing_Engine SHALL menghitung `required_credit` berdasarkan (`action_key`, `domain_suffix`) dengan referensi tabel `pricing_rules` versi aktif.
2. WHEN `required_credit` diterima, THE Wallet_Service SHALL menjalankan transaksi D1 yang: mengecek `balance_credit >= required_credit`, menulis entri `credit_ledger` bertipe `DEBIT` dengan `credit_delta = -required_credit`, dan meng-update `wallets.balance_credit = balance_credit - required_credit`.
3. IF `balance_credit < required_credit`, THEN THE Wallet_Service SHALL membatalkan aksi, mengembalikan HTTP 402 dengan kode `insufficient_credit`, dan TIDAK menulis entri ledger apapun.
4. THE Wallet_Service SHALL memastikan `wallets.balance_credit >= 0` setiap saat sebagai invariant database.
5. THE Pricing_Engine SHALL menggunakan tabel terpisah `pricing_rules` dengan `rule_key = action_cost_high_cost` untuk aksi high-cost (`send_mail`, `forward_mail`) alih-alih mengalikan hanya dengan domain weight.
6. THE Wallet_Service SHALL menulis `metadata` ledger yang berisi minimal `action_key`, `domain`, dan `resource_id` (mis. address id atau mail id) untuk setiap entri `DEBIT`.
7. WHEN aksi berbayar gagal karena error non-billing (mis. Email Routing API error) setelah debet sudah tercatat, THE Wallet_Service SHALL menulis entri `credit_ledger` bertipe `REFUND` dengan `credit_delta = +required_credit` dan mengembalikan saldo.

### Requirement 7: Pricing Rules Domain-weighted dan Admin Config

**User Story:** Sebagai admin, saya ingin mengatur aturan pricing tanpa redeploy, sehingga saya bisa merespons perubahan bisnis dan margin dengan cepat.

#### Acceptance Criteria

1. THE Billing_Admin_API SHALL menyediakan endpoint `GET /admin/billing/pricing_rules` dan `PUT /admin/billing/pricing_rules` untuk membaca dan memperbarui aturan pricing.
2. THE Pricing_Engine SHALL membaca aturan dari tabel `pricing_rules` untuk setiap request dan meng-cache dengan TTL maksimum 60 detik.
3. THE Pricing_Engine SHALL mendukung minimal `rule_key` berikut: `domain_weight_com`, `domain_weight_default`, `action_cost_create_address`, `action_cost_send_mail`, `action_cost_forward_mail`, `credit_idr_rate`, `bonus_threshold_idr`, `bonus_rate_percent`, `min_topup_idr`.
4. IF admin mencoba menyetel `domain_weight_com > 5`, THEN THE Billing_Admin_API SHALL menolak request dengan HTTP 400 dan kode `margin_guard_violation`.
5. IF admin mencoba menyetel `min_topup_idr < 10000`, THEN THE Billing_Admin_API SHALL menolak request dengan HTTP 400 dan kode `min_topup_violation`.
6. WHEN admin mengubah `pricing_rules`, THE Billing_Admin_API SHALL menaikkan kolom `version`, menandai baris lama `is_active = false`, dan menulis entri `Audit_Log` dengan `admin_id`, `rule_key`, `old_value`, `new_value`, `created_at`.
7. THE Pricing_Engine SHALL menggunakan hanya baris `is_active = true` dengan `version` tertinggi untuk setiap `rule_key`.

### Requirement 8: Riwayat Top-up dan Rekonsiliasi Status

**User Story:** Sebagai user dan sistem, saya ingin riwayat top-up dan status yang konsisten (termasuk expired otomatis), sehingga tidak ada transaksi "pending abadi".

#### Acceptance Criteria

1. THE Billing_API SHALL menyediakan endpoint `GET /user_api/topup/history?limit=&cursor=` yang mengembalikan transaksi top-up user terurut `created_at` desc.
2. THE Billing_API SHALL mengembalikan field `invoice_id`, `amount`, `fee`, `gross_amount`, `channel`, `status`, `created_at`, dan `paid_at` untuk setiap transaksi.
3. THE Topup_Reconciler SHALL berjalan sebagai scheduled Worker (cron) minimal setiap 5 menit untuk menandai transaksi `pending` yang lebih tua dari `expiry_minutes` (default 30) menjadi `expired`.
4. WHEN Topup_Reconciler menemukan transaksi `pending` yang sudah kedaluwarsa, THE Topup_Reconciler SHALL memanggil DompetX status API sebagai verifikasi akhir sebelum menandai `expired`.
5. IF DompetX mengembalikan status `paid` pada verifikasi akhir, THEN THE Topup_Reconciler SHALL memicu flow credit yang sama dengan webhook (idempotent via `invoice_id`).
6. THE Frontend_Wallet_UI SHALL me-refresh saldo dan status transaksi otomatis setelah kembali dari checkout (polling ringan `GET /user_api/topup/history` selama maksimum 2 menit atau sampai status berubah dari `pending`).

### Requirement 9: Admin Billing Management

**User Story:** Sebagai admin, saya ingin me-refresh cache channel pembayaran, melihat transaksi, mengatur pricing, dan melakukan manual credit adjust dengan audit trail, sehingga operasional harian bisa berjalan.

#### Acceptance Criteria

1. THE Billing_Admin_API SHALL menyediakan endpoint `POST /admin/billing/channels/refresh` yang memanggil DompetX list payment method dan menulis ulang `payment_channels_cache`.
2. THE Billing_Admin_API SHALL menyediakan endpoint `GET /admin/billing/topup_transactions?status=&user_id=&from=&to=` untuk melihat transaksi top-up dengan filter.
3. THE Billing_Admin_API SHALL menyediakan endpoint `POST /admin/billing/credit_adjust` yang menerima `user_id`, `credit_delta`, dan `reason`, lalu menulis entri `credit_ledger` bertipe `ADJUST` dan meng-update `wallets.balance_credit`.
4. WHEN admin melakukan credit adjust yang menyebabkan `wallets.balance_credit` turun di bawah 0, THE Billing_Admin_API SHALL menolak request dengan HTTP 400 dan kode `negative_balance_not_allowed`.
5. WHEN admin melakukan credit adjust, THE Audit_Log SHALL menulis entri dengan `admin_id`, `target_user_id`, `credit_delta`, `reason`, `created_at`.
6. THE Billing_Admin_API SHALL menggunakan middleware admin eksisting (`x-admin-auth`) tanpa mengubah perilaku middleware admin yang lain.

### Requirement 10: Anti-abuse dan Rate Limit

**User Story:** Sebagai operator, saya ingin melindungi endpoint top-up dan konsumsi kredit dari spam/abuse, sehingga infrastruktur dan margin tetap aman.

#### Acceptance Criteria

1. THE Abuse_Guard SHALL menerapkan rate limit pada `POST /user_api/topup/create` maksimal 5 request per user per 10 menit.
2. THE Abuse_Guard SHALL menerapkan rate limit pada `POST /user_api/topup/quote` maksimal 30 request per user per menit.
3. THE Frontend_Wallet_UI SHALL mengirim header fingerprint (`x-fingerprint`) yang di-hash saat memanggil endpoint billing.
4. WHEN lebih dari 10 user baru dari IP yang sama mencoba `POST /user_api/topup/create` dalam 1 jam, THE Abuse_Guard SHALL memblokir request berikutnya dari IP tersebut selama minimal 1 jam dan menulis entri audit.
5. IF request top-up tidak menyertakan fingerprint yang valid, THEN THE Billing_API SHALL menolak request dengan HTTP 400 dan kode `fingerprint_required`.
6. THE Abuse_Guard SHALL menyimpan counter rate limit di Cloudflare KV atau D1 dengan TTL sesuai window yang dikonfigurasi.

### Requirement 11: Promo Bonus Kredit

**User Story:** Sebagai user, saya ingin mendapat bonus kredit saat top-up di atas ambang tertentu, sehingga saya termotivasi top-up lebih besar.

#### Acceptance Criteria

1. WHEN sebuah top-up mencapai status `paid` dengan `amount >= bonus_threshold_idr`, THE Wallet_Service SHALL menulis satu entri tambahan `credit_ledger` bertipe `BONUS` dengan `credit_delta = floor(amount * bonus_rate_percent / 100 / credit_idr_rate)` dan meng-update `wallets.balance_credit` sesuai.
2. THE Wallet_Service SHALL menulis entri `BONUS` dalam transaksi D1 yang sama dengan entri `TOPUP` sehingga tidak pernah ada kondisi kreditkan topup tapi bonus lupa.
3. WHEN `amount < bonus_threshold_idr`, THE Wallet_Service SHALL TIDAK menulis entri `BONUS`.
4. THE Pricing_Engine SHALL membaca `bonus_threshold_idr` dan `bonus_rate_percent` dari `pricing_rules` sehingga admin dapat mengubahnya tanpa redeploy.
5. THE Frontend_Wallet_UI SHALL menampilkan label "Bonus +5%" (atau persentase aktif) di preset nominal yang memenuhi threshold.
6. WHEN webhook yang sama direplay, THE Wallet_Service SHALL memastikan bonus juga idempotent (tidak dikreditkan dua kali).

### Requirement 12: Observability dan KPI

**User Story:** Sebagai operator, saya ingin memantau KPI billing secara harian, sehingga saya bisa memutuskan go/no-go dan aksi margin guard.

#### Acceptance Criteria

1. THE Billing_Admin_API SHALL menyediakan endpoint `GET /admin/billing/kpi?from=&to=` yang mengembalikan `payment_success_rate`, `webhook_mismatch_rate`, `pending_over_30min_rate`, `net_margin_idr`, `refund_dispute_rate`.
2. THE Billing_Admin_API SHALL menghitung `payment_success_rate` sebagai `paid / (paid + failed + expired)` dalam window yang diminta.
3. WHEN `net_margin_monthly < 55%` tercapai dalam rolling 30 hari dan flag `margin_guard_auto = true`, THE Pricing_Engine SHALL otomatis menaikkan `domain_weight_com` sampai maksimum 5 dan mencatat entri `Audit_Log` bertipe `auto_margin_guard`.
4. THE Billing_Admin_API SHALL menolak request non-admin ke endpoint KPI dengan HTTP 401/403.
5. THE Billing_Admin_API SHALL menampilkan `webhook_mismatch_rate` berdasarkan jumlah webhook dengan signature invalid dibagi total webhook diterima dalam window yang sama.

### Requirement 13: Multi-domain Email Routing tetap Fungsional

**User Story:** Sebagai operator, saya ingin memastikan semua domain yang di-host di Cloudflare tetap menerima email dan routing ke Worker, sehingga alamat temp di domain apapun tetap berfungsi setelah billing dirilis.

#### Acceptance Criteria

1. THE Billing_API SHALL TIDAK mengubah entry point Email Worker (`email()` di `worker/src/email/index.ts`).
2. THE Pricing_Engine SHALL mengekstrak `domain_suffix` dari alamat recipient menggunakan TLD match (mis. `.com`, `.web.id`, `.my.id`) untuk menentukan domain weight.
3. WHERE sebuah domain terdaftar di `domains_allowlist` (konfigurasi Worker atau tabel `allowed_domains`), THE Billing_API SHALL mengizinkan pembuatan alamat temp di domain tersebut.
4. WHEN email masuk ke domain terdaftar, THE Email Worker SHALL tetap memproses pipeline eksisting (parse, junk check, exists check, auto-reply, forward, webhook, store) tanpa cek billing pada level incoming mail (karena biaya dibebankan pada create/send/forward, bukan receive).
5. IF admin menambahkan domain baru via `POST /admin/billing/domains`, THEN THE Billing_Admin_API SHALL memvalidasi domain sudah aktif di Cloudflare Email Routing sebelum menyimpan ke `allowed_domains`.

### Requirement 14: Migrasi dan Backward Compatibility

**User Story:** Sebagai pemilik produk, saya ingin memastikan user eksisting dan address eksisting tidak terganggu saat billing diaktifkan, sehingga tidak ada regresi pengalaman pengguna.

#### Acceptance Criteria

1. THE Billing_API SHALL memperlakukan semua `address` yang dibuat sebelum tanggal rilis billing (`billing_launch_at`) sebagai `grandfathered = true` dan TIDAK mendebet kredit untuk aksi rutin pada address tersebut (membaca mail, melihat inbox).
2. THE Billing_API SHALL tetap mendebet kredit untuk aksi high-cost (`send_mail`, `forward_mail`) pada address grandfathered.
3. WHEN user grandfathered membuat address baru setelah `billing_launch_at`, THE Billing_API SHALL menerapkan pricing normal pada address baru tersebut.
4. THE Billing_Admin_API SHALL menyediakan flag konfigurasi `grandfather_period_days` (default 30) untuk mengatur durasi grandfather.
5. WHEN `grandfather_period_days` terlampaui, THE Billing_API SHALL mulai menerapkan pricing normal pada semua address, termasuk yang dibuat sebelum `billing_launch_at`.
6. THE Billing_API SHALL TIDAK meregresi perilaku `/api/*`, `/admin/*`, `/open_api/*` eksisting untuk skenario non-billing (WebAuthn, OAuth2, SMTP/IMAP proxy, Email Routing).
7. THE Wallet_Service SHALL mem-back-fill `wallets` untuk seluruh user eksisting pada migration D1 dengan `balance_credit = 0` dan `balance_idr_ref = 0`.

*Catatan klarifikasi*: Keputusan final antara "grandfather 30 hari" vs "migrasi paksa ke paid model" perlu konfirmasi user sebelum tahap design; requirement di atas mengasumsikan grandfather period yang konfigurabel sebagai default.

### Requirement 15: Keamanan Data dan Secret Handling

**User Story:** Sebagai operator, saya ingin memastikan kredensial DompetX dan token Cloudflare tersimpan aman, sehingga tidak bocor ke frontend atau log publik.

#### Acceptance Criteria

1. THE Billing_API SHALL membaca `DOMPETX_API_KEY`, `DOMPETX_API_SECRET`, dan `DOMPETX_WEBHOOK_SECRET` hanya dari `wrangler secret` binding; nilai-nilai tersebut SHALL TIDAK pernah dikembalikan ke respons HTTP apapun.
2. THE Billing_API SHALL menggunakan Cloudflare API token yang scope-nya minimal `Email Routing:Edit` untuk operasi automation; token SHALL disimpan sebagai `wrangler secret` (`CLOUDFLARE_EMAIL_ROUTING_TOKEN`).
3. THE Frontend_Wallet_UI SHALL TIDAK pernah menerima atau menyimpan API key DompetX, webhook secret, atau Cloudflare token di kode frontend, env `VITE_*`, atau localStorage.
4. WHEN log produksi mencatat payload webhook, THE Payment_Webhook SHALL mem-masking field sensitif (`signature`, `api_key`) sebelum persist ke storage atau log.
5. THE Billing_API SHALL tidak mengembalikan `raw_payload` webhook ke endpoint user; `raw_payload` hanya boleh diakses admin via endpoint `GET /admin/billing/topup_transactions/:id`.
6. IF secret yang dibutuhkan tidak di-set di environment, THEN THE Billing_API SHALL gagal startup dengan error eksplisit alih-alih berjalan dengan konfigurasi kosong.

### Requirement 16: Daftar Channel Public

**User Story:** Sebagai frontend/public tool, saya ingin endpoint yang menampilkan daftar channel publik, sehingga halaman pricing publik bisa menampilkan channel tanpa perlu login.

#### Acceptance Criteria

1. THE Billing_API SHALL menyediakan endpoint public `GET /open_api/payment_channels?nominal=` tanpa auth.
2. WHEN `nominal` diberikan, THE Channel_Cache SHALL hanya mengembalikan channel yang memenuhi `is_active = true AND nominal >= channel.min AND (channel.max IS NULL OR nominal <= channel.max)`.
3. WHEN `nominal` tidak diberikan, THE Channel_Cache SHALL mengembalikan semua channel dengan `is_active = true` tanpa filter min/max.
4. THE Billing_API SHALL TIDAK mengembalikan `api_key`, `signature_secret`, atau kredensial channel apapun di response.
5. THE Channel_Cache SHALL memiliki TTL maksimum 10 menit; data yang lebih lama SHALL otomatis trigger re-fetch background saat endpoint dipanggil.

### Requirement 17: Internasionalisasi Bahasa Indonesia

**User Story:** Sebagai user berbahasa Indonesia, saya ingin UI dan pesan error tampil dalam Bahasa Indonesia, sehingga lebih mudah dipahami.

#### Acceptance Criteria

1. THE Frontend_Wallet_UI SHALL menyediakan locale `id` untuk semua string terkait billing (wallet, top-up, ledger, error) di samping locale eksisting `en` dan `zh`.
2. WHEN header `x-lang = id` dikirim ke Billing_API, THE Billing_API SHALL mengembalikan pesan error dalam Bahasa Indonesia.
3. THE Billing_API SHALL fallback ke locale `en` jika locale yang diminta tidak tersedia untuk pesan tertentu.
4. THE Frontend_Wallet_UI SHALL memilih locale default `id` untuk domain `automation.my.id` kecuali user mengganti manual.

### Requirement 18: Non-fungsional — Dokumentasi, Changelog, dan Release Hygiene

**User Story:** Sebagai maintainer, saya ingin memastikan repo tetap memiliki dokumentasi dan changelog bilingual setelah fitur billing dirilis, sehingga kontributor lain bisa melanjutkan pekerjaan.

#### Acceptance Criteria

1. THE Implementation SHALL memperbarui `CHANGELOG.md` (中文) dan `CHANGELOG_EN.md` (English) pada section `(main)` dengan entri format `- feat: |billing| <description>` untuk setiap increment fitur billing.
2. THE Implementation SHALL memperbarui `vitepress-docs/docs/zh/` dan `vitepress-docs/docs/en/` (minimal `guide/feature/billing.md` baru dan update `guide/worker-vars.md`) untuk semua environment variable baru (`DOMPETX_API_KEY`, `DOMPETX_API_SECRET`, `DOMPETX_WEBHOOK_SECRET`, `CLOUDFLARE_EMAIL_ROUTING_TOKEN`, dll.).
3. THE Implementation SHALL menambah referensi API billing ke `vitepress-docs/docs/*/api/` untuk endpoint user dan admin yang baru.
4. THE Implementation SHALL menambahkan test E2E Playwright minimal untuk happy-path top-up (mock DompetX) di `e2e/tests/api/billing-*.spec.ts`.
5. THE Implementation SHALL mengikuti Conventional Commits (`feat:`, `fix:`, `docs:`) untuk commit yang terkait billing.
6. THE Implementation SHALL menyimpan migration D1 baru dengan penamaan tanggal (`db/YYYY-MM-DD-billing-wallet.sql`).

### Requirement 19: Correctness Properties (untuk Property-based Testing)

**User Story:** Sebagai maintainer, saya ingin properti invariant yang dapat diuji otomatis (property-based testing), sehingga regresi keuangan bisa dicegah sejak CI.

#### Acceptance Criteria

1. FOR ALL `user_id`, THE Wallet_Service SHALL memastikan `SUM(credit_ledger.credit_delta WHERE user_id = :uid) = wallets.balance_credit WHERE user_id = :uid` (ledger sum invariant).
2. FOR ALL `invoice_id`, THE Payment_Webhook SHALL memastikan replay payload bertanda-tangan sama TIDAK menambah entri `credit_ledger` bertipe `TOPUP` lebih dari satu kali (webhook idempotency).
3. FOR ALL aksi `A` pada address dengan domain `D`, THE Pricing_Engine SHALL memastikan `credits_debited(A, D) = pricing_rule_for(A, D)` (domain-weighted pricing property).
4. FOR ALL `nominal < min_topup_idr`, THE Billing_API SHALL menolak `POST /user_api/topup/quote` dan `POST /user_api/topup/create` sebelum memanggil DompetX (min topup guard).
5. FOR ALL `channel` yang dikembalikan `GET /open_api/payment_channels?nominal=N`, THE Channel_Cache SHALL memenuhi `channel.is_active = true AND N >= channel.min AND (channel.max IS NULL OR N <= channel.max)` (channel filter property).
6. FOR ALL state wallet, THE Wallet_Service SHALL memastikan tidak ada aksi berbayar yang dapat menurunkan `balance_credit` di bawah 0 (no-negative-balance property).
7. FOR ALL top-up dengan `amount >= bonus_threshold_idr` berstatus `paid`, THE Wallet_Service SHALL memastikan bonus credits tepat `floor(amount * bonus_rate_percent / 100 / credit_idr_rate)` (bonus rule property).
8. FOR ALL pemanggilan `Pricing_Engine.resolve(action, domain)`, THE Pricing_Engine SHALL deterministic dalam window cache 60 detik yang sama (deterministic pricing property).
9. FOR ALL entri `credit_ledger` dengan tipe `DEBIT`, THE Wallet_Service SHALL memastikan `credit_delta < 0` dan untuk tipe `TOPUP`/`BONUS`/`REFUND` memastikan `credit_delta > 0` (sign invariant).
