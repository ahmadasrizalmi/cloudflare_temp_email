# SaaS Topup Credit Plan (Indonesia)

## 1) Tujuan

- Menjadikan aplikasi sebagai SaaS dengan model saldo kredit (topup) untuk pemakaian fitur email sementara.
- Menetapkan minimum topup `Rp10.000`.
- Menerapkan biaya kredit berbeda: domain `.com` lebih mahal dibanding non-`.com`.
- Integrasi pembayaran via DompetX dengan channel dinamis sesuai nominal.

## 2) Prinsip Produk

- Nominal topup minimum di aplikasi: `Rp10.000`.
- Nominal yang tampil ke user: cukup nominal topup (contoh `Rp10.000`, `Rp20.000`, dst).
- Total bayar akhir mengikuti hasil kalkulasi checkout DompetX (single source of truth).
- UI tetap menampilkan estimasi biaya admin agar user tidak kaget sebelum redirect/checkout.
- Konfigurasi fee per channel bisa berubah, jadi harus sinkron dari API/payment-method endpoint, bukan hardcode permanen.

## 3) Aturan Kredit (Initial)

- Konversi dasar: `1 credit = Rp100`.
- Biaya aksi non-`.com`: `1 credit`.
- Biaya aksi `.com`: `4 credit`.
- Guard margin:
- jika biaya channel ditanggung merchant, naikkan multiplier `.com` jadi `5 credit` saat margin bersih < target.
- untuk aksi high-cost (mis. send/forward tertentu), gunakan tabel credit terpisah.

## 4) Mapping Channel vs Nominal (UI Rules)

- Selalu filter channel dengan syarat:
- `is_active = true`
- `nominal >= min`
- `nominal <= max` (jika max ada)
- Untuk nominal `Rp10.000`:
- tampilkan channel yang min `<= Rp10.000` (contoh QRIS, BCA, BSI, Permata, Mandiri, Danamon, CIMB, dll sesuai status aktif).
- Untuk nominal `Rp15.000+`:
- boleh menampilkan tambahan channel dengan min `Rp15.000` (contoh BRI/BNI jika aktif).

## 5) Scope Implementasi Teknis

### Backend (Worker)

- Tambah modul billing baru:
- `worker/src/user_api/billing.ts` untuk endpoint user.
- `worker/src/admin_api/billing_admin.ts` untuk pengaturan/admin.
- Tambah routing:
- `worker/src/user_api/index.ts`
- `worker/src/admin_api/index.ts`
- Endpoint minimum:
- `GET /open_api/payment_channels` (cache + public list channel/limit)
- `POST /user_api/topup/quote` (hitung estimasi dan validasi min topup)
- `POST /user_api/topup/create` (buat transaksi DompetX)
- `POST /open_api/payment/webhook/dompetx` (webhook callback + verifikasi signature)
- `GET /user_api/topup/history` (riwayat transaksi user)
- `GET /user_api/wallet` (saldo, summary kredit)

### Database (D1)

- Tambah migration baru di `db/`:
- `YYYY-MM-DD-billing-wallet.sql`
- Tabel minimum:
- `wallets` (user_id, balance_credit, balance_idr_ref, updated_at)
- `topup_transactions` (id, user_id, invoice_id, amount, fee, gross_amount, channel, status, raw_payload, created_at, paid_at)
- `credit_ledger` (id, user_id, type[TOPUP/DEBIT/ADJUST], credit_delta, idr_ref, metadata, created_at)
- `pricing_rules` (rule_key, rule_value_json, version, is_active)
- `payment_channels_cache` (channel_code, min, max, fee_type, fee_value, fee_fixed, active, fetched_at)
- Idempotency:
- unique index untuk `invoice_id` dan `provider_reference`.

### Frontend

- Tambah halaman/section wallet user:
- Topup nominal input + preset (10k/20k/50k/100k).
- Pilihan channel yang difilter dari API.
- Summary: `Nominal`, `Estimasi fee`, `Total bayar`.
- Riwayat topup + status (`pending`, `paid`, `failed`, `expired`).
- Setelah payment success webhook:
- update saldo via polling ringan atau refresh endpoint wallet.

## 6) Integrasi DompetX

- Server-side only untuk API key/secret.
- Flow:
- user pilih nominal + channel
- backend validasi nominal minimum
- backend request create transaction ke DompetX
- simpan `pending` transaction
- user diarahkan ke instruksi/checkout DompetX
- DompetX webhook ke endpoint publik
- backend verifikasi signature + status payment
- backend crediting wallet sekali (idempotent)
- Jika toggle "Biaya ke Pelanggan" aktif:
- total bayar user di checkout bisa > nominal topup
- saldo kredit yang masuk tetap mengikuti nominal topup (bukan gross bayar).

## 7) Strategi Pricing (Awal)

- Paket minimum: `Rp10.000`.
- Rekomendasi paket cepat: `10k`, `20k`, `50k`, `100k`, `250k`.
- Domain weight:
- non-`.com`: 1x
- `.com`: 4x
- Opsi promo awal:
- bonus 5% kredit untuk topup `>= Rp100.000` agar CAC lebih efisien.

## 8) Simulasi Margin (Baseline)

Asumsi:
- AOV topup: `Rp20.000`
- Conversion: `3%` dari traffic harian
- Biaya operasional tetap: `Rp3.500.000/bulan`
- Biaya variabel platform: `Rp250/transaksi`
- Rata-rata fee channel jika merchant tanggung: `Rp2.200/transaksi`

### Skenario A: Fee Channel Dibebankan ke Pelanggan

- Traffic `500/hari` -> `15 tx/hari` -> estimasi net bulanan `Rp5.387.500`
- Traffic `1.500/hari` -> `45 tx/hari` -> estimasi net bulanan `Rp23.162.500`
- Traffic `5.000/hari` -> `150 tx/hari` -> estimasi net bulanan `Rp85.375.000`

### Skenario B: Fee Channel Ditanggung Merchant

- Traffic `500/hari` -> `15 tx/hari` -> estimasi net bulanan `Rp4.397.500`
- Traffic `1.500/hari` -> `45 tx/hari` -> estimasi net bulanan `Rp20.192.500`
- Traffic `5.000/hari` -> `150 tx/hari` -> estimasi net bulanan `Rp75.475.000`

Catatan:
- angka di atas adalah model baseline untuk pengambilan keputusan awal, bukan angka akuntansi final.
- wajib validasi 1-2 transaksi real per channel untuk cek fee settlement real dan webhook behavior.

## 9) Roadmap Eksekusi

### Phase 0 - Validation (1-2 hari)

- Finalisasi aturan bisnis:
- min topup = `Rp10.000`
- tabel credit `.com` vs non-`.com`
- UAT DompetX:
- 1 transaksi per 2-3 channel utama
- verifikasi nominal, fee, callback, status final

### Phase 1 - Foundation Billing (3-4 hari)

- DB migration wallet + transaksi + ledger.
- Endpoint wallet read + topup history.
- Endpoint payment channel cache + refresher job manual/admin.

### Phase 2 - Payment Flow (4-6 hari)

- Implement create transaction DompetX.
- Implement webhook callback + signature verify + idempotency.
- Crediting wallet saat status `paid`.

### Phase 3 - Frontend Wallet (3-5 hari)

- UI topup + channel + summary + status.
- Halaman riwayat topup.
- Refresh saldo otomatis pasca pembayaran.

### Phase 4 - Pricing Guard & Anti Abuse (2-3 hari)

- Rate limit create topup.
- Expiry & reconciliation job.
- Rule otomatis adjust multiplier `.com` jika margin drop.

### Phase 5 - Launch & Monitoring (ongoing)

- Dashboard KPI harian:
- topup count
- paid ratio
- gross topup
- net margin
- kredit consumed `.com` vs non-`.com`

## 10) KPI Go/No-Go

- Payment success rate >= `95%`
- Webhook mismatch < `1%`
- Pending > 30 menit < `3%`
- Net margin bulanan >= `55%` (target awal)
- Refund/dispute ratio < `1%`

## 11) Risiko Utama dan Mitigasi

- Fee channel berubah sewaktu-waktu:
- mitigasi: sinkron periodik payment channels + tidak hardcode.
- Double credit karena webhook retry:
- mitigasi: idempotency key + unique constraint + transaction lock.
- Abuse pembuatan akun/topup spam:
- mitigasi: rate limit, fingerprint, dan validasi device/IP.

## 12) Deliverable Akhir Yang Diharapkan

- Wallet & billing module aktif di worker + frontend.
- Topup minimal `Rp10.000` enforced.
- Perhitungan kredit `.com` vs non-`.com` berjalan stabil.
- Margin tracking dashboard siap dipantau harian.
