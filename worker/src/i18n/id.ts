import { LocaleMessages } from "./type";

// Bahasa Indonesia translations.
// Any key missing here will fall back to `en` via withFallback() in index.ts.
const messages: LocaleMessages = {
    CustomAuthPasswordMsg: "Anda telah mengaktifkan kata sandi situs privat, silakan masukkan kata sandinya",
    UserTokenExpiredMsg: "Token Anda telah kedaluwarsa, silakan login kembali",
    UserAcceesTokenExpiredMsg: "Access token Anda telah kedaluwarsa, silakan muat ulang halaman",
    UserRoleIsNotAdminMsg: "Peran akun Anda bukan admin, tidak dapat mengakses halaman ini",
    NeedAdminPasswordMsg: "Anda perlu memasukkan kata sandi admin untuk mengakses halaman ini",

    KVNotAvailableMsg: "KV tidak tersedia, silakan hubungi administrator",
    DBNotAvailableMsg: "Database tidak tersedia, silakan hubungi administrator",
    JWTSecretNotSetMsg: "JWT_SECRET belum dikonfigurasi, silakan hubungi administrator",
    WebhookNotEnabledMsg: "Webhook belum diaktifkan, silakan hubungi administrator",
    DomainsNotSetMsg: "Daftar domain belum dikonfigurasi, silakan hubungi administrator",

    TurnstileCheckFailedMsg: "Verifikasi manusia gagal",
    NewAddressDisabledMsg: "Pembuatan alamat baru dinonaktifkan, silakan hubungi administrator",
    NewAddressAnonymousDisabledMsg: "Pembuatan alamat baru untuk pengguna anonim dinonaktifkan, silakan hubungi administrator",
    FailedCreateAddressMsg: "Gagal membuat alamat",
    InvalidAddressMsg: "Alamat tidak valid",
    InvalidAddressCredentialMsg: "Kredensial alamat tidak valid",
    UserDeleteEmailDisabledMsg: "Penghapusan alamat/email oleh pengguna dinonaktifkan, silakan hubungi administrator",

    UserNotFoundMsg: "Pengguna tidak ditemukan",
    UserAlreadyExistsMsg: "Pengguna sudah terdaftar, silakan login",
    FailedToRegisterMsg: "Gagal mendaftar",
    UserRegistrationDisabledMsg: "Registrasi pengguna dinonaktifkan, silakan hubungi administrator",
    UserMailDomainMustInMsg: "Domain email pengguna harus ada di daftar ini",
    UserEmailNotMatchRegexMsg: "Format alamat email tidak sesuai dengan pola yang diperlukan",
    InvalidVerifyCodeMsg: "Kode verifikasi tidak valid",
    InvalidEmailOrPasswordMsg: "Email atau kata sandi tidak valid",
    VerifyMailSenderNotSetMsg: "Alamat pengirim email verifikasi belum dikonfigurasi, silakan hubungi administrator",
    CodeAlreadySentMsg: "Kode sudah dikirim, mohon tunggu",
    InvalidUserDefaultRoleMsg: "Peran default pengguna tidak valid, silakan hubungi administrator",
    FailedUpdateUserDefaultRoleMsg: "Gagal memperbarui peran default pengguna, silakan hubungi administrator",

    Oauth2ClientIDNotFoundMsg: "OAuth2 client ID belum dikonfigurasi, silakan hubungi administrator",
    Oauth2CliendIDOrCodeMissingMsg: "OAuth2 client ID atau code tidak tersedia",
    Oauth2FailedGetUserInfoMsg: "Gagal mengambil informasi pengguna dari penyedia OAuth2",
    Oauth2FailedGetAccessTokenMsg: "Gagal mengambil access token dari penyedia OAuth2",
    Oauth2FailedGetUserEmailMsg: "Gagal mengambil email pengguna dari penyedia OAuth2",

    PasswordChangeDisabledMsg: "Perubahan kata sandi dinonaktifkan",
    NewPasswordRequiredMsg: "Kata sandi baru wajib diisi",
    InvalidAddressTokenMsg: "Token alamat tidak valid",
    FailedUpdatePasswordMsg: "Gagal memperbarui kata sandi",
    PasswordLoginDisabledMsg: "Login dengan kata sandi dinonaktifkan",
    EmailPasswordRequiredMsg: "Email dan kata sandi wajib diisi",
    AddressNotFoundMsg: "Alamat tidak ditemukan",

    // Common messages (merged similar ones)
    OperationFailedMsg: "Operasi gagal",
    RequiredFieldMsg: "Kolom wajib belum diisi",
    InvalidInputMsg: "Input tidak valid",

    // Address related
    NameTooShortMsg: "Nama terlalu pendek",
    NameTooLongMsg: "Nama terlalu panjang",
    InvalidDomainMsg: "Domain tidak valid",
    RandomSubdomainNotAllowedMsg: "Subdomain acak tidak diaktifkan untuk domain ini",
    AddressAlreadyExistsMsg: "Alamat sudah ada",
    MaxAddressCountReachedMsg: "Jumlah alamat mencapai batas maksimum",
    AddressNotBindedMsg: "Alamat belum ditautkan",
    AddressAlreadyBindedMsg: "Alamat sudah ditautkan, silakan lepas tautan terlebih dahulu",
    TargetUserNotFoundMsg: "Pengguna target tidak ditemukan",

    // Send mail related
    NoBalanceMsg: "Saldo tidak mencukupi",
    AddressBlockedMsg: "Alamat diblokir",
    SubjectEmptyMsg: "Subjek tidak boleh kosong",
    ContentEmptyMsg: "Isi pesan tidak boleh kosong",
    AlreadyRequestedMsg: "Permintaan sudah diajukan sebelumnya",
    EnableResendOrSmtpMsg: "Silakan aktifkan resend atau smtp untuk domain ini",
    EnableResendOrSmtpOrSendMailMsg: "Silakan aktifkan resend, smtp, atau SEND_MAIL untuk domain ini",
    ServerSendMailDailyLimitMsg: "Kuota pengiriman email harian server telah tercapai",
    ServerSendMailMonthlyLimitMsg: "Kuota pengiriman email bulanan server telah tercapai",
    InvalidToMailMsg: "Alamat penerima tidak valid",

    // Admin related
    InvalidAddressIdMsg: "address_id tidak valid",
    EnableKVMsg: "Silakan aktifkan KV terlebih dahulu",
    EnableSendMailMsg: "Silakan aktifkan SEND_MAIL terlebih dahulu",
    EnableSendMailForDomainMsg: "Silakan aktifkan SEND_MAIL untuk domain ini terlebih dahulu",
    InvalidCleanupConfigMsg: "cleanType atau cleanDays tidak valid",
    InvalidCleanTypeMsg: "cleanType tidak valid",
    EnableKVForMailVerifyMsg: "Silakan aktifkan KV terlebih dahulu jika ingin mengaktifkan verifikasi email",
    VerifyMailDomainInvalidMsg: "Domain VerifyMailSender harus ada di",
    InvalidMaxAddressCountMsg: "maxAddressCount tidak valid",
    FailedDeleteUserMsg: "Gagal menghapus pengguna",
    InvalidUserIdMsg: "user_id tidak valid",
    InvalidRoleTextMsg: "role_text tidak valid",

    // SQL validation
    SqlEmptyMsg: "Pernyataan SQL kosong",
    SqlTooLongMsg: "Pernyataan SQL terlalu panjang (maks. 1000 karakter)",
    SqlOnlyDeleteMsg: "Hanya pernyataan DELETE yang diizinkan",
    SqlSingleStatementMsg: "Hanya diperbolehkan satu pernyataan SQL",
    SqlNoCommentsMsg: "Komentar SQL tidak diizinkan",

    // Passkey related
    InvalidPasskeyNameMsg: "Nama passkey tidak valid",
    PasskeyNotFoundMsg: "Passkey tidak ditemukan",
    AuthenticationFailedMsg: "Autentikasi gagal",
    RegistrationFailedMsg: "Registrasi gagal",

    // Auto reply related
    AutoReplyDisabledMsg: "Balasan otomatis dinonaktifkan",
    InvalidAutoReplyMsg: "Subjek atau pesan tidak valid",
    SubjectOrMessageTooLongMsg: "Subjek atau pesan terlalu panjang",

    // Bind address related
    NoAddressOrUserTokenMsg: "Alamat atau token pengguna tidak tersedia",
    InvalidAddressOrUserTokenMsg: "Alamat atau token pengguna tidak valid",

    // Pagination related
    InvalidLimitMsg: "Parameter limit tidak valid",
    InvalidOffsetMsg: "Parameter offset tidak valid",

    // Clear inbox/sent items related
    FailedClearInboxMsg: "Gagal mengosongkan kotak masuk",
    FailedClearSentItemsMsg: "Gagal mengosongkan email terkirim",

    // Webhook related
    WebhookNotAllowedForUserMsg: "Pengaturan webhook tidak diizinkan untuk pengguna ini",

    // IP blacklist related
    InvalidIpBlacklistSettingMsg: "Pengaturan blacklist IP tidak valid",
    BlacklistExceedsMaxSizeMsg: "Blacklist melebihi ukuran maksimum",

    // Billing error messages
    InsufficientCreditMsg: "Saldo kredit tidak mencukupi",
    DomainNotAllowedMsg: "Domain tidak diizinkan untuk tindakan berbayar",
    NominalBelowMinimumMsg: "Nominal top-up di bawah batas minimum yang diizinkan",
    ChannelNotEligibleMsg: "Saluran pembayaran tidak memenuhi syarat untuk nominal ini",
    FingerprintRequiredMsg: "Sidik jari perangkat diperlukan",
    RateLimitedMsg: "Terlalu banyak permintaan, silakan coba lagi nanti",
    DuplicateInvoiceMsg: "Invoice sudah ada",
    MarginGuardViolationMsg: "Nilai melanggar batasan margin guard (domain_weight_com harus ≤ 5)",
    MinTopupViolationMsg: "Nilai melanggar batasan top-up minimum (min_topup_idr harus ≥ 10000)",
    NegativeBalanceNotAllowedMsg: "Penyesuaian kredit akan mengakibatkan saldo negatif",
    UnknownActionMsg: "Tindakan tidak dikenal, tidak ada aturan harga yang ditemukan",
    InvoiceNotFoundMsg: "Invoice tidak ditemukan",

    // Telegram bot messages
    TgUnableGetUserInfoMsg: "Tidak dapat mengambil informasi pengguna",
    TgNoPermissionMsg: "Anda tidak memiliki izin untuk menggunakan bot ini",
    TgWelcomeMsg: "Selamat datang! Anda dapat membuka mini app",
    TgCurrentPrefixMsg: "Prefiks aktif saat ini:",
    TgCurrentDomainsMsg: "Domain yang tersedia:",
    TgAvailableCommandsMsg: "Perintah yang tersedia:",
    TgCreateSuccessMsg: "Alamat berhasil dibuat:",
    TgCreateFailedMsg: "Gagal membuat alamat:",
    TgBindSuccessMsg: "Berhasil menautkan:",
    TgBindFailedMsg: "Gagal menautkan:",
    TgUnbindSuccessMsg: "Berhasil melepas tautan:",
    TgUnbindFailedMsg: "Gagal melepas tautan:",
    TgDeleteSuccessMsg: "Berhasil dihapus:",
    TgDeleteFailedMsg: "Gagal menghapus:",
    TgAddressListMsg: "Daftar alamat:",
    TgGetAddressFailedMsg: "Gagal mengambil daftar alamat:",
    TgCleanSuccessMsg: "Alamat tidak valid berhasil dibersihkan:",
    TgCurrentAddressListMsg: "Daftar alamat saat ini:",
    TgCleanFailedMsg: "Gagal membersihkan alamat tidak valid:",
    TgNotBoundAddressMsg: "Alamat ini belum ditautkan:",
    TgInvalidAddressMsg: "Alamat tidak valid",
    TgNoMoreMailsMsg: "Tidak ada email lagi",
    TgNoMailMsg: "Tidak ada email",
    TgGetMailFailedMsg: "Gagal mengambil email:",
    TgParseMailFailedMsg: "Gagal mengurai email:",
    TgViewMailBtnMsg: "Lihat Email",
    TgPrevBtnMsg: "Sebelumnya",
    TgNextBtnMsg: "Berikutnya",
    TgPleaseInputCredentialMsg: "Silakan masukkan kredensial",
    TgPleaseInputAddressMsg: "Silakan masukkan alamat",
    TgAddressMsg: "Alamat:",
    TgPasswordMsg: "Kata sandi:",
    TgCredentialMsg: "Kredensial:",
    TgNoSenderMsg: "Tidak ada pengirim",
    TgMsgTooLongMsg: "Pesan terlalu panjang, silakan buka di mini app",
    TgParseFailedViewInAppMsg: "Gagal mengurai, silakan buka di mini app",
    TgMaxAddressReachedMsg: "Batas maksimum alamat telah tercapai",
    TgMaxAddressReachedCleanMsg: "Batas maksimum alamat telah tercapai, silakan jalankan /cleaninvalidaddress terlebih dahulu",
    TgInvalidCredentialMsg: "Kredensial tidak valid",
    TgAddressNotYoursMsg: "Alamat ini bukan milik Anda",
    TgLangSetSuccessMsg: "Bahasa berhasil diatur:",
    TgCurrentLangMsg: "Bahasa saat ini:",
    TgSelectLangMsg: "Silakan pilih bahasa:",
    TgNoPermissionViewMailMsg: "Tidak memiliki izin untuk melihat email ini",
    TgBotTokenRequiredMsg: "TELEGRAM_BOT_TOKEN wajib diisi",
    TgLangFeatureDisabledMsg: "Fitur pengaturan bahasa dinonaktifkan. Bahasa default sistem digunakan.",
}

export default messages;
