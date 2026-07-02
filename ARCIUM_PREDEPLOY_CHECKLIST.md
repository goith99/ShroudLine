# Arcium Pre-Deploy Checklist — WAJIB dicek SEBELUM deploy pertama, bukan setelah gagal

Disusun dari akumulasi kegagalan nyata di 4 project: Secret Garden, NullRef,
ShadeIntent/Privacy DEX, Private Prediction Settlement. Tujuan: cek SEMUA ini
sekaligus di awal project baru, bukan menemukan satu-satu setelah tiap gagal deploy.

## 1. Versi toolchain — cek SEBELUM `arcium init`
- [ ] `arcup list` — lihat versi apa saja yang ter-install
- [ ] Samakan ke versi yang SUDAH terbukti jalan di project sebelumnya
      (referensi: solana-arcium-skill repo — saat ini 0.11.1), BUKAN
      versi default/lama yang kebetulan ter-install
- [ ] `arcup use <versi>` SEBELUM `arcium init`, bukan setelah masalah muncul
- [ ] Cek versi `arcis`, `arcium-anchor`, `arcium-macros`, `arcium-client`,
      `@arcium-hq/client` semua konsisten satu sama lain

## 2. Ukuran akun program — set headroom besar dari deploy PERTAMA
- [ ] Setelah deploy pertama kali, LANGSUNG jalankan:
      `solana program extend <program_id> 50000 --url <rpc> --keypair <path>`
- [ ] Jangan tunggu sampai upgrade berikutnya gagal karena mentok ukuran

## 3. RPC — pilih tier yang cukup SEBELUM deploy besar
- [ ] Jangan pakai RPC publik default sama sekali
- [ ] Cek tier (Free/Dev/Business) dan limit request/detik di dashboard provider
      SEBELUM mulai deploy, bukan setelah kena 429
- [ ] Untuk `solana program deploy`: JANGAN pakai `--use-rpc` kecuali terpaksa
      (default TPU broadcast jauh lebih sedikit membebani RPC)
- [ ] `--max-sign-attempts 100 --with-compute-unit-price 50000` sebagai default aman

## 4. Urutan command deploy yang benar
- [ ] `arcium build` dulu, SELALU — bukan `anchor build` (macro butuh artifact .arcis)
- [ ] `arcium deploy --cluster-offset 456 --recovery-set-size 4 --keypair-path <path> --rpc-url <rpc>`
      dalam SATU command kalau memungkinkan (mencakup bytecode + MXE init)
- [ ] Kalau gagal di tengah: coba `--resume` dulu SEBELUM workaround manual
- [ ] Cluster offset devnet: 456 (jangan re-derive, sudah terverifikasi via `arcium list-clusters`)

## 5. Setelah deploy sukses, sebelum test
- [ ] Init comp-def untuk SETIAP circuit
- [ ] Kalau circuit besar: pertimbangkan offchain circuit storage (URL + hash),
      bukan upload bytecode penuh on-chain
- [ ] `Enc<Mxe,T>` HANYA bisa diisi lewat circuit khusus, tidak boleh sentinel
      bytes dari client — cek ini di code review sebelum test

## Prinsip umum
Diagnosis kegagalan deploy: cek SEMUA 4 kategori di atas (versi, ukuran akun,
RPC, urutan command) SEKALIGUS kalau ada error yang tidak jelas — jangan
diagnosis satu-satu berurutan (itu yang bikin siklus gagal berulang-ulang
dan menghabiskan waktu + SOL).
