# Charon

Telegram autonomous agent for screening Pump.fun tokens with overlap signals, strategy gates, LLM selection, and dry-run/confirm/live execution.

## What It Does

- **Poll** signal server for Pump.fun tokens every 30 seconds
- **Gate** candidates through strategy filters (fees, mcap, holders, trend)
- **Enrich** with Jupiter/GMGN data
- **LLM select** best candidate for entry
- **Execute** via dry_run / confirm / live modes (Jupiter Ultra swaps)
- **Monitor** positions for TP/SL/trailing TP

## Tech Stack

| Layer | Tech | Purpose |
|-------|------|---------|
| Runtime | Node.js | Backend |
| AI | LLM (MiniMax/OpenAI) | Candidate selection |
| Swap | Jupiter Ultra | Token execution |
| Signal | GMGN API | Holder/liquidity data |
| Storage | SQLite | Positions, configs, logs |

## Getting Started

```bash
git clone git@github.com:sonyy/charon.git
cd charon
npm install
cp .env.example .env
```

Edit `.env` and run:

```bash
npm start
```

## Strategies

- **sniper**: fee-claim overlap, immediate entry, LLM on
- **dip_buy**: ATH-distance dip alerts
- **smart_money**: stricter holder/trending quality, partial TP
- **degen**: rule-based (no LLM)

## Commands

```
/menu /strategy /positions /wallets
```

## Required Config

```env
TELEGRAM_BOT_TOKEN=        # From @BotFather
TELEGRAM_CHAT_ID=          # Chat ID for alerts
SIGNAL_SERVER_URL=         # Pump.fun aggregator
SIGNAL_SERVER_KEY=         # Your API key
SOLANA_RPC_URL=            # Helius RPC
JUPITER_API_KEY=           # Jupiter Ultra API
```

## Status

Currently testing period — no guarantee of results. Configs in `.env` require restart.