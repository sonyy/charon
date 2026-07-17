# Charon — CLAUDE.md

Telegram trench agent untuk screening Pump-token flow dengan overlap signals, strategy gates, LLM selection, dan dry-run/confirm/live execution. Sumber signal dari signal server (aggregasi fee-claim/graduated/trending Pump.fun) atau mode standalone (polling langsung).

> **Audience**: future agents/sessions yang perlu memahami atau memodifikasi bot ini.

## TL;DR
- Entry: `node index.js` (`startCharon()`), `npm start`, PM2 (`pm2 start index.js --name charon`).
- Flow: poll signal server → strategy gates → enrich (Jupiter/GMGN) → LLM pilih kandidat → route dry_run/confirm/live (Jupiter Ultra swap) → monitor posisi (TP/SL/trailing).
- Storage: `charon.sqlite` (source of truth — candidates, decisions, positions, trades, strategies, lessons).
- Strategies: `sniper` / `dip_buy` / `smart_money` / `degen` — disimpan di SQLite, hot-read.
- Telegram commands: `/menu`, `/strategy`, `/stratset`, `/positions`, `/filters`, `/pnl`, `/learn`, `/wallets`.
- Execution modes (`.env` `TRADING_MODE`): `dry_run` | `confirm` | `live`.

## ⚡ Communication Rules
- High-level only; jawab yang ditanya; bahasa manusia; singkat & padat.
- Baca `README.md` untuk detail env/config sebelum ubah behavior.
- **Direct tools untuk lookup sederhana** — cari identifier/konstan sederhana (grep, find constant) pakai tools langsung (`grep`, `read`), jangan spawn sub-agent. Sub-agent untuk search kompleks multi-repo, bukan lookup satu value.

## ⚡ Parallel Execution (multi-worker)

Gunakan multiple worker secara paralel dalam mengerjakan task yang diberikan ke kamu. Kalau ada banyak langkah independen — baca beberapa modul, analisis beberapa kandidat/token, jalankan beberapa pengecekan sekaligus — jalankan bersamaan, jangan serial satu per satu. Manfaatkan mekanisme sub-agent / parallel tool calls untuk throughput maksimal.

### ⚠️ Failure mode (learned from experience)

**Before proposing ANY change — including answering "what should we do?" — you MUST:**

1. **Check data first.** Baca file state yang relevan (`charon.sqlite`, `strategy-library.json`) dan cross-reference dengan klaimmu. JANGAN extrapolasi dari kode saja.
2. **If user asks a question, answer the question.** Jangan implement, suggest, atau config-change kecuali user secara eksplisit meminta aksi.
3. **Zero config changes without analysis.** Jangan sentuh `TRADING_MODE` atau ubah strategy gates / threshold tanpa:
   - Membaca data performa historis yang mendukung perubahan
   - Mempertimbangkan dampak ke posisi/strategi lain
   - Memastikan perubahan tidak menghalangi pola profitable yang sudah ter-identifikasi
4. **When unsure, say "saya perlu liat data dulu" before proposing anything.**

## ⚡ Execution-mode parity (HARD RULE)

- **Pastikan `dry_run`, `confirm`, dan `live` SELALU SAMA dalam logika.** Setiap
  perubahan pada screening, strategy gates, enrich, LLM selection, atau monitoring
  yang dibuat di satu mode HARUS diterapkan ke mode lainnya. Ketiga mode tidak
  boleh divergen dalam pengambilan keputusan — `TRADING_MODE` hanya mengubah
  apakah tx dikirim (atau menunggu konfirmasi), bukan bagaimana kandidat dipilih.
- Mode `dry_run`/`confirm` hanya me-skip pengiriman tx aktual (atau menunggu
  approval). Mereka TIDAK boleh me-skip signal poll, enrich, strategy gate,
  safety check, atau logging apa pun yang juga dijalankan di `live`.
- Sebelum menyelesaikan perubahan, pastikan path tiap mode pada kode yang
  disentuh menghasilkan kandidat/keputusan yang sama. Jangan biarkan fix menetap
  di dry_run saja tanpa juga masuk ke live.
