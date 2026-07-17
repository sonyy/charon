import { now, json } from '../utils.js';
import { numSetting, boolSetting, strategyById } from '../db/settings.js';
import { db } from '../db/connection.js';
import { firstPositiveNumber, marketCapFromGmgn, tokenPriceFromGmgn } from '../utils.js';
import { fetchGmgnTokenInfo } from '../enrichment/gmgn.js';
import { fetchJupiterAsset, fetchJupiterHolders, fetchJupiterChartContext, jupiterAssetBackoffActive } from '../enrichment/jupiter.js';
import { fetchSavedWalletExposure } from '../enrichment/wallets.js';
import { filterCandidate } from '../pipeline/candidateBuilder.js';
import { openPositions } from '../db/positions.js';
import { updateCandidateSnapshot } from '../db/candidates.js';
import { trending } from '../signals/trending.js';
import { executeLiveSell } from './router.js';
import { sendPositionExit } from '../telegram/send.js';

export async function freshEntryMarket(mint, candidate) {
  const gmgn = await fetchGmgnTokenInfo(mint, false);
  const asset = await fetchJupiterAsset(mint, { useCache: false });
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), asset?.usdPrice, candidate.metrics?.priceUsd);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    asset?.mcap,
    asset?.fdv,
    candidate.metrics?.marketCapUsd,
    candidate.metrics?.graduatedMarketCapUsd,
  );
  return { gmgn, asset, priceUsd, marketCapUsd, refreshedAtMs: now() };
}

export async function refreshCandidateForExecution(row) {
  const candidate = row.candidate;
  const mint = candidate.token.mint;
  const gmgn = await fetchGmgnTokenInfo(mint, false);
  const asset = await fetchJupiterAsset(mint, { useCache: false });
  const holders = await fetchJupiterHolders(mint);
  const chart = await fetchJupiterChartContext(mint);
  const selectedTrending = trending.get(mint) || candidate.trending || null;
  const selectedHolders = holders?.holders?.length ? holders : candidate.holders;
  const selectedSavedWalletExposure = selectedHolders
    ? await fetchSavedWalletExposure(mint, selectedHolders)
    : candidate.savedWalletExposure;
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), asset?.usdPrice, selectedTrending?.price, candidate.metrics?.priceUsd);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    asset?.mcap,
    asset?.fdv,
    selectedTrending?.market_cap,
    candidate.metrics?.marketCapUsd,
    candidate.metrics?.graduatedMarketCapUsd,
  );
  const refreshed = {
    ...candidate,
    token: {
      ...candidate.token,
      name: gmgn?.name || asset?.name || selectedTrending?.name || candidate.token.name,
      symbol: gmgn?.symbol || asset?.symbol || selectedTrending?.symbol || candidate.token.symbol,
      twitter: candidate.token.twitter || asset?.twitter || gmgn?.link?.twitter_username || selectedTrending?.twitter || '',
      website: candidate.token.website || asset?.website || gmgn?.link?.website || '',
      telegram: candidate.token.telegram || gmgn?.link?.telegram || '',
    },
    metrics: {
      ...candidate.metrics,
      priceUsd,
      marketCapUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? asset?.liquidity ?? selectedTrending?.liquidity ?? candidate.metrics?.liquidityUsd ?? 0),
      holderCount: Number(gmgn?.holder_count ?? asset?.holderCount ?? selectedTrending?.holder_count ?? candidate.metrics?.holderCount ?? 0),
      gmgnTotalFeesSol: Number(gmgn?.total_fee ?? asset?.fees ?? candidate.metrics?.gmgnTotalFeesSol ?? 0),
      gmgnTradeFeesSol: Number(gmgn?.trade_fee ?? candidate.metrics?.gmgnTradeFeesSol ?? 0),
      trendingVolumeUsd: Number(selectedTrending?.volume ?? candidate.metrics?.trendingVolumeUsd ?? 0),
      trendingSwaps: Number(selectedTrending?.swaps ?? candidate.metrics?.trendingSwaps ?? 0),
      trendingHotLevel: Number(selectedTrending?.hot_level ?? candidate.metrics?.trendingHotLevel ?? 0),
      trendingSmartDegenCount: Number(selectedTrending?.smart_degen_count ?? candidate.metrics?.trendingSmartDegenCount ?? 0),
    },
    gmgn,
    jupiterAsset: asset,
    trending: selectedTrending,
    holders: selectedHolders,
    chart,
    savedWalletExposure: selectedSavedWalletExposure,
    executionRefresh: {
      refreshedAtMs: now(),
      source: 'pre_execution',
      marketCapUsd,
      priceUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? asset?.liquidity ?? selectedTrending?.liquidity ?? 0),
      holdersRefreshed: Boolean(holders?.holders?.length),
    },
  };
  refreshed.filters = filterCandidate(refreshed);
  const executionFailures = [];
  if (!Number.isFinite(Number(refreshed.metrics.marketCapUsd)) || Number(refreshed.metrics.marketCapUsd) <= 0) {
    executionFailures.push('execution mcap: missing');
  }
  if (!Number.isFinite(Number(refreshed.metrics.priceUsd)) || Number(refreshed.metrics.priceUsd) <= 0) {
    executionFailures.push('execution price: missing');
  }
  if (executionFailures.length) {
    refreshed.filters = {
      ...refreshed.filters,
      passed: false,
      failures: [...(refreshed.filters?.failures || []), ...executionFailures],
    };
  }
  updateCandidateSnapshot(row.id, refreshed, refreshed.filters.passed ? 'candidate' : 'filtered');
  return { ...row, candidate: refreshed };
}

const sellInProgress = new Set();

// ponytail: hardcoded Jupiter cost basis; upgrade to per-swap quote when available
const JUPITER_SLIPPAGE_BPS = 300;
const JUPITER_FEE_BPS = 40;

export async function refreshPosition(position, { autoExit = true } = {}) {
  const backoff = jupiterAssetBackoffActive();
  const asset = await fetchJupiterAsset(position.mint);
  const price = Number(asset?.usdPrice);
  const mcap = firstPositiveNumber(asset?.mcap, asset?.fdv);
  const haveFreshPrice = Number.isFinite(price) && price > 0 && Number.isFinite(Number(mcap)) && Number(mcap) > 0;
  if (!haveFreshPrice || (backoff && autoExit)) {
    if (autoExit) {
      console.log(`[position] ${position.id} skipping — ${backoff ? 'jupiter backoff (stale price)' : 'no fresh price'}`);
      return null;
    }
    // Manual status request: return stored state, no exit evaluation on a stale price.
    return { ...position, exitReason: null };
  }
  const entryPrice = Number(position.entry_price);
  const entryMcap = Number(position.entry_mcap);
  if (!(entryPrice > 0 && entryMcap > 0)) return null;
  return evaluatePositionExit(position, price, mcap, { autoExit, asset });
}

// Shared exit evaluation used by both the batch-price path and the per-position Jupiter fallback.
// `asset` is the Jupiter asset object (null when called from the batch path — callers must not rely on it).
export async function evaluatePositionExit(position, price, mcap, { autoExit = true, asset = null } = {}) {
  if (!Number.isFinite(Number(position.entry_mcap)) || Number(position.entry_mcap) <= 0) {
    return null;
  }
  const highWaterMcap = Math.max(Number(position.high_water_mcap || 0), Number(mcap));
  const highWaterPrice = Math.max(Number(position.high_water_price || 0), Number(price || 0));
  let pnlPercent = (Number(mcap) / Number(position.entry_mcap) - 1) * 100;
  let pnlSol = Number(position.size_sol) * pnlPercent / 100;
  // Use MCAP ratio consistently for both dry_run and live.
  // Slippage simulation is applied at exit time, not during monitoring.
  const strat = strategyById(position.strategy_id);
  const tpHit = pnlPercent >= Number(position.tp_percent);
  const slHit = Number(position.sl_percent) < 0 && pnlPercent <= Number(position.sl_percent);
  const trailingActivatePct = Number(strat?.trailing_activate_percent ?? position.trailing_percent ?? 15);
  const peakPnlPct = Number(highWaterMcap) > 0 && Number(position.entry_mcap) > 0
    ? (Number(highWaterMcap) / Number(position.entry_mcap) - 1) * 100
    : pnlPercent;
  const trailingArmed = position.trailing_armed || (position.trailing_enabled && (tpHit || pnlPercent >= trailingActivatePct || peakPnlPct >= trailingActivatePct));
  const trailDrop = highWaterMcap > 0 ? (Number(mcap) / highWaterMcap - 1) * 100 : 0;
  // Progressive trailing tiers: format "activatePct:trailPct,activatePct:trailPct,..."
  // e.g. "30:15,60:20,100:30,200:40" means:
  //   at 30% PnL → 15% trail, at 60% PnL → 20% trail, at 100% → 30%, at 200% → 40%
  let effectiveTrailPct = Number(position.trailing_percent);
  const trailTiers = strat?.trail_tiers;
  if (trailingArmed && trailTiers) {
    const tiers = String(trailTiers).split(',').map(t => {
      const [act, tr] = t.split(':').map(Number);
      return { activatePct: act, trailPct: tr };
    }).sort((a, b) => a.activatePct - b.activatePct);
    for (const tier of tiers) {
      if (peakPnlPct >= tier.activatePct) {
        effectiveTrailPct = tier.trailPct;
      }
    }
  }
  const trailingHit = trailingArmed && position.trailing_enabled && trailDrop <= -Math.abs(effectiveTrailPct);

  if (trailingArmed && !position.trailing_armed) {
    console.log(`[trailing] ${position.id} armed activatePct=${trailingActivatePct} pnl=${pnlPercent.toFixed(1)}% peakPnl=${peakPnlPct.toFixed(1)}%`);
  }
  if (trailingArmed && trailTiers && effectiveTrailPct !== Number(position.trailing_percent)) {
    console.log(`[trailing] ${position.id} tier: ${effectiveTrailPct}% trail @ ${peakPnlPct.toFixed(1)}% peak (default ${position.trailing_percent}%)`);
  }
  if (trailingHit) {
    console.log(`[trailing] ${position.id} HIT trailDrop=${trailDrop.toFixed(1)}% trailPct=${effectiveTrailPct}%`);
  }
  let exitReason = null;
  let closed = false;

  // Max hold time check
  if (strat?.max_hold_ms > 0 && (now() - position.opened_at_ms) >= strat.max_hold_ms) {
    exitReason = 'MAX_HOLD';
  }

  // Partial TP check
  if (!exitReason && strat?.partial_tp && !position.partial_tp_done && pnlPercent >= strat.partial_tp_at_percent) {
    db.prepare('UPDATE dry_run_positions SET partial_tp_done = 1 WHERE id = ?').run(position.id);
    console.log(`[position] ${position.id} partial TP at ${pnlPercent.toFixed(1)}% (${strat.partial_tp_sell_percent}% sell)`);
    if (position.execution_mode === 'live' && position.token_amount_raw) {
      try {
        const sellAmount = Math.floor(Number(position.token_amount_raw) * (strat.partial_tp_sell_percent / 100));
        if (sellAmount > 0) {
          const sell = await executeLiveSell({ ...position, token_amount_raw: String(sellAmount) }, 'PARTIAL_TP');
          const remaining = Number(position.token_amount_raw) - sellAmount;
          db.prepare('UPDATE dry_run_positions SET token_amount_raw = ? WHERE id = ?').run(String(remaining), position.id);
          db.prepare(`
            INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
            VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, 'PARTIAL_TP', ?)
          `).run(position.id, position.mint, now(), price, mcap,
            position.size_sol * (strat.partial_tp_sell_percent / 100), sellAmount,
            json({ pnlPercent, sell, partialSellPercent: strat.partial_tp_sell_percent, remaining }));
          console.log(`[position] ${position.id} partial TP sold ${sellAmount} tokens, ${remaining} remaining`);
        }
      } catch (err) {
        console.log(`[position] ${position.id} partial sell failed: ${err.message}`);
      }
    } else if (position.execution_mode !== 'live') {
      const sellAmountSol = Number(position.size_sol) * (strat.partial_tp_sell_percent / 100);
      const remainingSol = Number(position.size_sol) - sellAmountSol;
      db.prepare('UPDATE dry_run_positions SET size_sol = ? WHERE id = ?').run(remainingSol, position.id);
      db.prepare(`
        INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
        VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, 'PARTIAL_TP', ?)
      `).run(position.id, position.mint, now(), price, mcap, sellAmountSol, null,
        json({ pnlPercent, partialSellPercent: strat.partial_tp_sell_percent, remainingSol, simulated: true }));
      console.log(`[position] ${position.id} dry_run partial TP: sold ${sellAmountSol.toFixed(4)} SOL, ${remainingSol.toFixed(4)} remaining`);
    }
  }

  // Rug guard: catastrophic drop from peak fires regardless of trailing-armed state.
  // Takes precedence over SL when both would fire.
  const rugGuardDropPct = Number(strat?.rug_guard_drop_pct ?? 0);
  if (!exitReason && rugGuardDropPct > 0 && highWaterMcap > 0 && trailDrop <= -rugGuardDropPct) {
    exitReason = 'RUG_GUARD';
  }

  // Standard exit checks
  if (!exitReason) {
    if (slHit) exitReason = 'SL';
    else if (tpHit && !position.trailing_enabled) exitReason = 'TP';
    else if (trailingHit) exitReason = 'TRAILING_TP';
  }

  // Gain floor: once trailing is armed, never give back 100% of unrealized profit.
  // A formerly-winning position that falls back to/below entry is force-exited via TRAILING_TP
  // instead of riding a loose low-tier trail (e.g. +15% peak -> 30% trail -> -15% exit) into a loss.
  if (!exitReason && trailingArmed && pnlPercent <= 0) {
    exitReason = 'TRAILING_TP';
  }

  const bepActivatePct = numSetting('bep_activate_pct', 3);
  const bepExitPct = Math.min(numSetting('bep_exit_pct', 0.9), bepActivatePct);
  if (!exitReason && bepActivatePct > 0 && peakPnlPct >= bepActivatePct && pnlPercent <= bepExitPct) {
    exitReason = 'BEP_EXIT';
  }

  // Track current PnL and max/min unrealized PnL
  const curMaxPnl = position.max_pnl_sol != null ? position.max_pnl_sol : -Infinity;
  const curMinPnl = position.min_pnl_sol != null ? position.min_pnl_sol : Infinity;
  const newMaxPnl = curMaxPnl === -Infinity ? pnlSol : Math.max(curMaxPnl, pnlSol);
  const newMinPnl = curMinPnl === Infinity ? pnlSol : Math.min(curMinPnl, pnlSol);

  // Live exits will override these with realized SOL values
  let finalPnlPercent = pnlPercent;
  let finalPnlSol = pnlSol;

  db.prepare(`
    UPDATE dry_run_positions
    SET high_water_mcap = ?, high_water_price = ?, trailing_armed = ?,
        current_pnl_sol = ?, current_pnl_percent = ?,
        max_pnl_sol = ?, min_pnl_sol = ?
    WHERE id = ?
  `).run(highWaterMcap, highWaterPrice, trailingArmed ? 1 : 0,
        pnlSol, pnlPercent, newMaxPnl, newMinPnl, position.id);

  if (exitReason && autoExit && position.execution_mode === 'live') {
    if (sellInProgress.has(position.id)) return { ...position, exitReason: null };
    sellInProgress.add(position.id);
    let sell;
    try {
      sell = await executeLiveSell(position, exitReason);
    } finally {
      sellInProgress.delete(position.id);
    }
    const receivedLamports = Number(sell.outputAmount || 0);
    const receivedSol = receivedLamports > 0 ? receivedLamports / 1_000_000_000 : null;
    if (receivedSol != null) {
      finalPnlSol = receivedSol - Number(position.size_sol);
      finalPnlPercent = (receivedSol / Number(position.size_sol) - 1) * 100;
    }
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?,
          pnl_percent = ?, pnl_sol = ?, exit_signature = ?
      WHERE id = ?
    `).run(now(), price, mcap, exitReason, finalPnlPercent, finalPnlSol, sell.signature, position.id);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
    `).run(position.id, position.mint, now(), price, mcap, position.size_sol, position.token_amount_est, exitReason, json({ pnlPercent: finalPnlPercent, pnlSol: finalPnlSol, receivedSol: receivedSol ?? null, sell }));
    closed = true;
  } else if (exitReason && autoExit) {
    const slippageCostPct = (JUPITER_SLIPPAGE_BPS + JUPITER_FEE_BPS) / 10000 * 100;
    finalPnlPercent = pnlPercent - slippageCostPct;
    finalPnlSol = Number(position.size_sol) * finalPnlPercent / 100;
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?, pnl_percent = ?, pnl_sol = ?
      WHERE id = ?
    `).run(now(), price, mcap, exitReason, finalPnlPercent, finalPnlSol, position.id);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
    `).run(position.id, position.mint, now(), price, mcap, position.size_sol, position.token_amount_est, exitReason, json({ pnlPercent: finalPnlPercent, pnlSol: finalPnlSol }));
    closed = true;
  }
  return {
    ...position,
    status: closed ? 'closed' : position.status,
    closed_at_ms: closed ? now() : position.closed_at_ms,
    asset,
    price,
    mcap,
    highWaterMcap,
    high_water_mcap: highWaterMcap,
    high_water_price: highWaterPrice,
    pnlPercent: finalPnlPercent,
    pnl_percent: finalPnlPercent,
    pnlSol: finalPnlSol,
    pnl_sol: finalPnlSol,
    exitReason: closed ? exitReason : null,
    exit_reason: closed ? exitReason : position.exit_reason,
    exit_mcap: closed ? mcap : position.exit_mcap,
    exit_price: closed ? price : position.exit_price,
  };
}

let monitoringInFlight = false;
export async function monitorPositions() {
  if (monitoringInFlight) return; // prevent overlap when a cycle exceeds POSITION_CHECK_MS
  monitoringInFlight = true;
  try {
    const positions = openPositions();
    for (const position of positions) {
      const result = await refreshPosition(position, { autoExit: true }).catch((err) => {
        console.log(`[position] ${position.id} ${err.message}`);
        return null;
      });
      if (result?.exitReason) await sendPositionExit(result);
    }
  } finally {
    monitoringInFlight = false;
  }
}
