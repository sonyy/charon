import express from 'express';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import axios from 'axios';
import { initLiveExecution, executeJupiterSwap } from './src/liveExecutor.js';
import { WSOL_MINT } from './src/config.js';

function now() { return Date.now(); }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

const dbPath = path.join(__dirname, 'charon.sqlite');
if (!fs.existsSync(dbPath)) {
  console.error(`Database not found at ${dbPath}`);
  process.exit(1);
}
let db;
function openDb(readonly = true) {
  if (db) { try { db.close(); } catch {} }
  db = new Database(dbPath, { readonly });
  db.pragma('busy_timeout = 15000');
  db.pragma('cache_size = -24000');
  db.pragma('temp_store = MEMORY');
  if (!readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('journal_size_limit = 8388608');
    db.pragma('wal_autocheckpoint = 1000');
  }
  db.pragma('mmap_size = 26843545600');
}
openDb(true);

const app = express();

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

// Auto-recover: if DB was closed by error, reopen on next request
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    try { db.prepare('SELECT 1').get(); } catch {
      try { openDb(true); } catch {}
    }
  }
  next();
});

app.get('/api/summary', (req, res) => {
  try {
    const closed = db.prepare(`
      SELECT
        COUNT(*) as closedCount,
        COALESCE(SUM(pnl_sol), 0) as totalPnlSol,
        COALESCE(AVG(pnl_percent), 0) as avgPnlPercent,
        COALESCE(SUM(size_sol), 0) as totalSizeSol,
        SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN pnl_sol < 0 THEN 1 ELSE 0 END) as losses
      FROM dry_run_positions WHERE status = 'closed'
    `).get();

    const open = db.prepare("SELECT COUNT(*) as c FROM dry_run_positions WHERE status = 'open'").get();
    const total = db.prepare("SELECT COUNT(*) as c FROM dry_run_positions").get();

    const best = db.prepare("SELECT symbol, pnl_sol FROM dry_run_positions WHERE status = 'closed' AND pnl_sol IS NOT NULL ORDER BY pnl_sol DESC LIMIT 1").get();
    const worst = db.prepare("SELECT symbol, pnl_sol FROM dry_run_positions WHERE status = 'closed' AND pnl_sol IS NOT NULL ORDER BY pnl_sol ASC LIMIT 1").get();

    const winRate = closed.closedCount > 0 ? Number(((closed.wins / closed.closedCount) * 100).toFixed(1)) : 0;

    res.json({
      totalPositions: total.c,
      openPositions: open.c,
      closedPositions: closed.closedCount,
      totalPnlSol: Number(closed.totalPnlSol.toFixed(6)),
      totalPnlPercent: Number(closed.avgPnlPercent.toFixed(2)),
      totalSizeSol: Number(closed.totalSizeSol.toFixed(4)),
      winCount: closed.wins,
      lossCount: closed.losses,
      winRate,
      bestTrade: best || null,
      worstTrade: worst || null,
    });
  } catch (err) {
    console.error('Summary error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/positions', (req, res) => {
  try {
    const { status, strategy } = req.query;
    const rows = db.prepare(`
      SELECT id, candidate_id, mint, symbol, status, opened_at_ms, closed_at_ms,
             size_sol, entry_price, entry_mcap, exit_price, exit_mcap, exit_reason,
             pnl_percent, pnl_sol, tp_percent, sl_percent, trailing_percent, strategy_id, execution_mode,
             current_pnl_sol, current_pnl_percent, max_pnl_sol, min_pnl_sol
      FROM dry_run_positions
      WHERE (? = '' OR status = ?)
        AND (? = '' OR strategy_id = ?)
      ORDER BY opened_at_ms DESC
      LIMIT 1000
    `).all(status || '', status || '', strategy || '', strategy || '');

    const formatted = rows.map(r => ({
      ...r,
      opened_at: r.opened_at_ms ? new Date(r.opened_at_ms).toISOString() : null,
      closed_at: r.closed_at_ms ? new Date(r.closed_at_ms).toISOString() : null,
    }));

    res.json(formatted);
  } catch (err) {
    console.error('Positions error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/positions/:id/trades', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Invalid position ID' });
    }

    const posPnl = db.prepare(`
      SELECT current_pnl_sol, current_pnl_percent, max_pnl_sol, min_pnl_sol
      FROM dry_run_positions WHERE id = ?
    `).get(id) || {};

    const trades = db.prepare(`
      SELECT id, side, at_ms, price, mcap, size_sol, reason, payload_json
      FROM dry_run_trades WHERE position_id = ?
      ORDER BY at_ms ASC
    `).all(id);

    const formatted = trades.map(t => {
      let pnlInfo = {};
      try { pnlInfo = JSON.parse(t.payload_json || '{}'); } catch {}
      return {
        id: t.id,
        side: t.side,
        at: t.at_ms ? new Date(t.at_ms).toISOString() : null,
        price: t.price,
        mcap: t.mcap,
        size_sol: t.size_sol,
        reason: t.reason,
        pnlPercent: pnlInfo.pnlPercent ?? null,
        pnlSol: pnlInfo.pnlSol ?? null,
        currentPnlSol: posPnl.current_pnl_sol ?? null,
        currentPnlPercent: posPnl.current_pnl_percent ?? null,
        maxPnlSol: posPnl.max_pnl_sol ?? null,
        minPnlSol: posPnl.min_pnl_sol ?? null,
      };
    });

    res.json(formatted);
  } catch (err) {
    console.error('Trades error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/settings', (req, res) => {
  try {
    const settingsRows = db.prepare("SELECT key, value FROM settings").all();
    const settings = {};
    for (const row of settingsRows) {
      settings[row.key] = row.value;
    }

    const activeStrategy = db.prepare("SELECT * FROM strategies WHERE enabled = 1 LIMIT 1").get();
    let strategyConfig = {};
    if (activeStrategy) {
      try { strategyConfig = JSON.parse(activeStrategy.config_json || '{}'); } catch {}
    }

    res.json({
      settings,
      activeStrategy: activeStrategy ? {
        id: activeStrategy.id,
        name: activeStrategy.name,
        config: strategyConfig,
      } : null,
    });
  } catch (err) {
    console.error('Settings error:', err);
    res.status(500).json({ error: err.message });
  }
});

function pickBestBucket(buckets, minCount = 2) {
  if (!buckets.length) return null;
  const candidates = buckets.filter(b => b.count >= minCount);
  if (!candidates.length) return null;
  const maxWr = Math.max(...candidates.map(b => b.wr));
  const best = candidates.filter(b => b.wr === maxWr);
  return best.sort((a, b) => b.count - a.count)[0];
}

function pickBestBucketByPnl(buckets, minCount = 2) {
  if (!buckets.length) return null;
  const candidates = buckets.filter(b => b.count >= minCount);
  if (!candidates.length) return null;
  return candidates.sort((a, b) => (b.avgPnl || 0) - (a.avgPnl || 0))[0];
}

app.get('/api/analysis', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT p.pnl_sol, p.exit_reason, p.entry_mcap, p.size_sol, p.sl_percent, p.tp_percent, p.trailing_percent, p.opened_at_ms, p.closed_at_ms,
             c.candidate_json
      FROM dry_run_positions p
      LEFT JOIN candidates c ON p.candidate_id = c.id
      WHERE p.status = 'closed' AND c.candidate_json IS NOT NULL
      ORDER BY p.opened_at_ms DESC
      LIMIT 2000
    `).all();

    const fmt = (v) => v != null && Number.isFinite(v) ? Number(v) : null;

    const analyzed = rows.map(r => {
      const cj = JSON.parse(r.candidate_json);
      const metrics = cj.metrics || {};
      const holders = cj.holders || { holders: [] };
      const top10 = holders.holders.slice(0, 10).reduce((s, h) => s + (h.percent || 0), 0);
      return {
        pnl_sol: fmt(r.pnl_sol),
        exit_reason: r.exit_reason || 'unknown',
        entry_mcap: fmt(r.entry_mcap),
        size_sol: fmt(r.size_sol),
        sl_percent: fmt(r.sl_percent),
        tp_percent: fmt(r.tp_percent),
        trailing_percent: fmt(r.trailing_percent),
        opened_at_ms: r.opened_at_ms,
        closed_at_ms: r.closed_at_ms,
        top10Pct: top10,
        liquidityUsd: fmt(metrics.liquidityUsd || 0),
        holderCount: holders.count || metrics.holderCount || 0,
        trendingVolumeUsd: fmt(metrics.trendingVolumeUsd || 0),
        trendingSwaps: fmt(metrics.trendingSwaps || 0),
      };
    });

    const total = analyzed.length;
    const wins = analyzed.filter(a => a.pnl_sol > 0);
    const losses = analyzed.filter(a => a.pnl_sol < 0);
    const winRate = total ? wins.length / total * 100 : 0;

    const rnd = (v, d = 2) => v != null ? Number(v.toFixed(d)) : null;
    const avg = (arr, fn) => {
      const vals = arr.map(fn).filter(v => v != null && Number.isFinite(v));
      return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
    };
    const sum = (arr, fn) => arr.reduce((s, v) => s + (fn(v) || 0), 0);
    const wr = (arr) => arr.length ? arr.filter(a => a.pnl_sol > 0).length / arr.length * 100 : 0;

    // ── Exit reason breakdown ──
    const exitGroups = {};
    for (const a of analyzed) {
      const r = a.exit_reason;
      if (!exitGroups[r]) exitGroups[r] = [];
      exitGroups[r].push(a);
    }
    const exitBreakdown = Object.entries(exitGroups).sort((a, b) => b[1].length - a[1].length).map(([reason, items]) => ({
      reason,
      count: items.length,
      pct: rnd(items.length / total * 100),
      totalPnl: rnd(sum(items, i => i.pnl_sol)),
      avgPnl: rnd(avg(items, i => i.pnl_sol)),
      wr: rnd(wr(items)),
    }));

    // ── Metric thresholds: pick best based on WR ──
    function buildBuckets(items, accessor, thresholds, filterDir) {
      return thresholds.map(t => {
        const g = filterDir === 'le' ? items.filter(a => accessor(a) <= t) : items.filter(a => accessor(a) >= t);
        return g.length ? { threshold: t, count: g.length, wr: rnd(wr(g)), avgPnl: rnd(avg(g, i => i.pnl_sol)) } : null;
      }).filter(Boolean);
    }

    function analyzeMetric(analyzed, accessor, thresholds, dir) {
      const raw = buildBuckets(analyzed, accessor, thresholds, dir);
      const vals = analyzed.map(accessor).filter(v => v != null && Number.isFinite(v));
      if (!vals.length) return { buckets: raw, best: null };
      const obsMin = Math.min(...vals);
      const obsMax = Math.max(...vals);
      const meaningful = dir === 'le' ? raw.filter(b => b.threshold < obsMax) : raw.filter(b => b.threshold > obsMin);
      return { buckets: raw, best: pickBestBucket(meaningful, 2), obsMin, obsMax };
    }

    // Dynamic metric analysis — add new metrics here
    const metricDefs = [
      { key: 'Top10%', thresholdKey: 'bestTop10', accessor: a => a.top10Pct,
        thresholds: [20, 25, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48, 50, 55, 60, 70, 80, 100], dir: 'le',
        fmt: (v) => '\u2264' + v + '%' },
      { key: 'Liq', thresholdKey: 'bestLiq', accessor: a => a.liquidityUsd,
        thresholds: [0, 1000, 3000, 5000, 8000, 10000, 15000, 20000], dir: 'ge',
        fmt: (v) => '\u2265$' + v.toLocaleString() },
      { key: 'Holders', thresholdKey: 'bestHolders', accessor: a => a.holderCount,
        thresholds: [10, 20, 30, 40, 50, 60, 80, 100], dir: 'ge',
        fmt: (v) => '\u2265' + v },
      { key: 'MCAP', thresholdKey: 'bestMcap', accessor: a => a.entry_mcap,
        thresholds: [10000, 30000, 50000, 75000, 100000, 150000, 200000, 300000, 500000, 1000000], dir: 'le',
        fmt: (v) => '\u2264' + (v >= 1000 ? '$' + (v/1000).toFixed(0) + 'K' : '$' + v.toFixed(0)) },
      { key: 'Size', thresholdKey: 'bestSize', accessor: a => a.size_sol,
        thresholds: [0, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5], dir: 'ge',
        fmt: (v) => '\u2265' + v + ' SOL' },
      { key: 'Volume', thresholdKey: 'bestVolume', accessor: a => a.trendingVolumeUsd || 0,
        thresholds: [0, 1000, 5000, 10000, 50000, 100000, 500000], dir: 'ge',
        fmt: (v) => '\u2265' + (v >= 1000 ? '$' + (v/1000).toFixed(1) + 'K' : '$' + v.toFixed(0)) },
      { key: 'Swaps', thresholdKey: 'bestSwaps', accessor: a => a.trendingSwaps || 0,
        thresholds: [0, 10, 50, 100, 200, 500, 1000], dir: 'ge',
        fmt: (v) => '\u2265' + v.toLocaleString() },
    ];

    const bestParams = [];
    const metricResults = {};
    for (const def of metricDefs) {
      const res = analyzeMetric(analyzed, def.accessor, def.thresholds, def.dir);
      metricResults[def.thresholdKey] = res.best;
      if (res.best && res.best.count >= 2) {
        bestParams.push({ label: def.key, value: def.fmt(res.best.threshold), wr: res.best.wr, count: res.best.count });
      }
    }
    const { bestTop10, bestLiq, bestHolders, bestMcap, bestSize, bestVolume, bestSwaps } = metricResults;

    // ── Trailing analysis ──
    const trailGroups = {};
    analyzed.filter(a => a.exit_reason === 'TRAILING_TP').forEach(a => {
      const pct = a.trailing_percent || 0;
      if (!trailGroups[pct]) trailGroups[pct] = [];
      trailGroups[pct].push(a);
    });
    const trailingBreakdown = Object.entries(trailGroups).sort((a, b) => Number(a[0]) - Number(b[0])).map(([pct, items]) => ({
      pct,
      count: items.length,
      wr: rnd(wr(items)),
      totalPnl: rnd(sum(items, i => i.pnl_sol)),
      avgPnl: rnd(avg(items, i => i.pnl_sol)),
    }));

    const bestTrail = trailingBreakdown.filter(t => t.count >= 2).sort((a, b) => (b.avgPnl || 0) - (a.avgPnl || 0))[0] || null;

    // ── SL analysis ──
    const slItems = analyzed.filter(a => a.exit_reason === 'SL');
    const slData = {
      count: slItems.length,
      pct: total ? rnd(slItems.length / total * 100) : 0,
      totalPnl: rnd(sum(slItems, i => i.pnl_sol)),
      avgPnl: rnd(avg(slItems, i => i.pnl_sol)),
      wr: rnd(wr(slItems)),
    };

    // ── MCAP analysis: winners vs losers ──
    const winnerMcaps = wins.map(a => a.entry_mcap).filter(v => v > 0);
    const loserMcaps = losses.map(a => a.entry_mcap).filter(v => v > 0);
    const mcapAnalysis = {
      winnerAvg: avg(winnerMcaps, v => v),
      loserAvg: avg(loserMcaps, v => v),
      winnerMin: winnerMcaps.length ? Math.min(...winnerMcaps) : null,
      loserMax: loserMcaps.length ? Math.max(...loserMcaps) : null,
    };

    // ── TP analysis ──
    const tpItems = analyzed.filter(a => a.exit_reason === 'TAKE_PROFIT');
    const tpData = {
      count: tpItems.length,
      totalPnl: rnd(sum(tpItems, i => i.pnl_sol)),
      avgPnl: rnd(avg(tpItems, i => i.pnl_sol)),
    };

    // ── Build recommendations ──
    const recs = [];

    // read current strategy config
    const activeCfg = (() => {
      try {
        const s = db.prepare("SELECT config_json FROM strategies WHERE enabled = 1 LIMIT 1").get();
        return s ? JSON.parse(s.config_json || '{}') : {};
      } catch { return {}; }
    })();

    const currentMap = {
      top10HolderPercent: activeCfg.max_top10_holder_percent,
      minLiquidityUsd: activeCfg.min_liquidity_usd,
      minHolders: activeCfg.min_holders,
      entryMcapUsd: activeCfg.max_mcap_usd,
      minSizeSol: activeCfg.position_size_sol,
      trendingVolumeUsd: activeCfg.trending_min_volume_usd,
      trendingSwaps: activeCfg.trending_min_swaps,
    };

    function fmtCurrent(metricKey, val) {
      if (val == null) return null;
      if (metricKey === 'top10HolderPercent') return val + '%';
      if (metricKey === 'minLiquidityUsd') return '$' + Number(val).toLocaleString();
      if (metricKey === 'minHolders') return String(val);
      if (metricKey === 'entryMcapUsd') return Number(val) >= 1e6 ? '$'+(Number(val)/1e6).toFixed(2)+'M' : Number(val) >= 1e3 ? '$'+(Number(val)/1e3).toFixed(1)+'K' : '$'+Number(val).toFixed(0);
      if (metricKey === 'minSizeSol') return Number(val).toFixed(3) + ' SOL';
      if (metricKey === 'trendingVolumeUsd') return Number(val) >= 1e6 ? '$'+(Number(val)/1e6).toFixed(2)+'M' : Number(val) >= 1e3 ? '$'+(Number(val)/1e3).toFixed(1)+'K' : '$'+Number(val).toFixed(0);
      if (metricKey === 'trendingSwaps') return Number(val).toLocaleString();
      return String(val);
    }

    function addRec(metricKey, label, best, dir, buffer, maxVal) {
      if (!best || best.count < 3) return;
      let val, unit = '';
      if (buffer != null) {
        val = Math.min(maxVal || Infinity, best.threshold + buffer);
      } else {
        val = best.threshold;
      }
      const arrow = dir === 'le' ? '\u2264' : '\u2265';
      const valStr = metricKey === 'top10HolderPercent' ? 'max ' + val + '%'
        : arrow + (metricKey === 'minLiquidityUsd' ? '$' + val.toLocaleString()
          : metricKey === 'minHolders' ? ' ' + val
          : metricKey === 'entryMcapUsd' ? (val >= 1e6 ? '$'+(val/1e6).toFixed(2)+'M' : val >= 1e3 ? '$'+(val/1e3).toFixed(1)+'K' : '$'+val.toFixed(0))
          : metricKey === 'trendingVolumeUsd' ? (val >= 1e6 ? '$'+(val/1e6).toFixed(2)+'M' : val >= 1e3 ? '$'+(val/1e3).toFixed(1)+'K' : '$'+val.toFixed(0))
          : metricKey === 'trendingSwaps' ? val.toLocaleString()
          : metricKey === 'minSizeSol' ? val.toFixed(3) + ' SOL'
          : val + '');
      recs.push({
        metric: metricKey,
        value: val,
        label: valStr,
        current: fmtCurrent(metricKey, currentMap[metricKey]),
        reason: `WR ${best.wr}% at ${arrow}${best.threshold}${metricKey === 'top10HolderPercent' ? '%' : ''} (${best.count} pos)`
      });
    }

    addRec('top10HolderPercent', 'Top10%', bestTop10, 'le', 10, 60);
    addRec('minLiquidityUsd', 'Liq', bestLiq, 'ge');
    addRec('minHolders', 'Holders', bestHolders, 'ge');
    addRec('entryMcapUsd', 'MCAP', bestMcap, 'le');
    addRec('minSizeSol', 'Size', bestSize, 'ge');
    addRec('trendingVolumeUsd', 'Volume', bestVolume, 'ge');
    addRec('trendingSwaps', 'Swaps', bestSwaps, 'ge');

    if (bestTrail) {
      recs.push({ metric: 'trailingPercent', value: Number(bestTrail.pct), reason: `avg PnL ${bestTrail.avgPnl} SOL at ${bestTrail.pct}% trail (${bestTrail.count} pos)` });
    }

    // ── Profit Factor ──
    const grossWin = sum(wins, a => a.pnl_sol);
    const grossLoss = Math.abs(sum(losses, a => a.pnl_sol));
    const profitFactor = grossLoss > 0 ? rnd(grossWin / grossLoss) : wins.length > 0 ? Infinity : 0;

    // ── Biggest win / biggest loss ──
    const biggestWin = wins.length ? rnd(Math.max(...wins.map(a => a.pnl_sol))) : null;
    const biggestLoss = losses.length ? rnd(Math.min(...losses.map(a => a.pnl_sol))) : null;

    // ── Avg hold duration (hours) ──
    const dur = (arr) => {
      const vals = arr.filter(a => a.opened_at_ms && a.closed_at_ms).map(a => (a.closed_at_ms - a.opened_at_ms) / 3600000);
      return vals.length ? rnd(vals.reduce((s, v) => s + v, 0) / vals.length, 1) : null;
    };

    // ── Avg entry MCAP ──
    const avgEntryMcap = rnd(avg(analyzed, a => a.entry_mcap));

    res.json({
      total,
      winRate: rnd(winRate),
      winCount: wins.length,
      lossCount: losses.length,
      avgWin: rnd(avg(wins, a => a.pnl_sol)),
      avgLoss: rnd(avg(losses, a => Math.abs(a.pnl_sol))),
      totalPnl: rnd(sum(analyzed, a => a.pnl_sol)),
      exitBreakdown,
      trailingBreakdown,
      slData,
      tpData,
      mcapAnalysis,
      bestTop10,
      bestLiq,
      bestHolders,
      bestMcap,
      bestSize,
      bestVolume,
      bestSwaps,
      bestTrail,
      bestParams,
      recommendations: recs,
      profitFactor,
      biggestWin,
      biggestLoss,
      avgDurationWin: dur(wins),
      avgDurationLoss: dur(losses),
    });
  } catch (err) {
    console.error('Analysis error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/strategies', (req, res) => {
  try {
    const rows = db.prepare("SELECT DISTINCT strategy_id FROM dry_run_positions WHERE strategy_id IS NOT NULL ORDER BY strategy_id").all();
    res.json(rows.map(r => r.strategy_id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/potential-analysis', (req, res) => {
  try {
    // ── 1. Get closed trades to build winner profile ──
    const tradeRows = db.prepare(`
      SELECT p.pnl_sol, p.entry_mcap, c.candidate_json
      FROM dry_run_positions p
      LEFT JOIN candidates c ON p.candidate_id = c.id
      WHERE p.status = 'closed' AND c.candidate_json IS NOT NULL
    `).all();

    const fmt = v => v != null && Number.isFinite(v) ? Number(v) : null;

    function extractMetrics(cj) {
      const m = cj.metrics || {};
      const h = cj.holders || {};
      const top10 = h.holders ? h.holders.slice(0, 10).reduce((s, hh) => s + (hh.percent || 0), 0) : 0;
      return {
        top10Pct: top10,
        liquidityUsd: Number(m.liquidityUsd) || 0,
        holderCount: h.count || Number(m.holderCount) || 0,
        volume: Number(m.trendingVolumeUsd) || 0,
        swaps: Number(m.trendingSwaps) || 0,
      };
    }

    const winners = [];
    const losers = [];
    for (const r of tradeRows) {
      const pnl = fmt(r.pnl_sol);
      if (pnl == null) continue;
      try {
        const cj = JSON.parse(r.candidate_json);
        const m = extractMetrics(cj);
        (pnl > 0 ? winners : losers).push(m);
      } catch (_) {}
    }

    if (!winners.length || !losers.length) {
      return res.json({ error: 'Need both winners and losers to compare', winners: 0, losers: 0 });
    }

    // ── 2. Compute winner metric bounds (min/max) ──
    const bounds = ['top10Pct', 'liquidityUsd', 'holderCount', 'volume', 'swaps'].map(key => {
      const wVals = winners.map(w => w[key]);
      const lVals = losers.map(l => l[key]);
      return {
        key,
        winnerMin: Math.min(...wVals),
        winnerMax: Math.max(...wVals),
        loserMin: Math.min(...lVals),
        loserMax: Math.max(...lVals),
        higherIsBetter: ['liquidityUsd', 'holderCount', 'volume', 'swaps'].includes(key),
      };
    });

    // ── 3. Score rejected candidates ──
    const filteredRows = db.prepare(`
      SELECT c.candidate_json, c.filter_result_json
      FROM candidates c
      WHERE c.status = 'filtered' AND c.candidate_json IS NOT NULL
    `).all();

    const scored = [];
    const filterHitByScore = {};

    for (const r of filteredRows) {
      try {
        const cj = JSON.parse(r.candidate_json);
        const metrics = extractMetrics(cj);
        const fr = JSON.parse(r.filter_result_json);
        const failures = fr.failures || [];

        let score = 0;
        const details = [];
        for (const b of bounds) {
          const val = metrics[b.key];
          const inWinnerZone = val >= b.winnerMin && val <= b.winnerMax;
          const inLoserZone = val >= b.loserMin && val <= b.loserMax;
          if (inWinnerZone && !inLoserZone) {
            score += 2;
            details.push({ key: b.key, val, verdict: 'winner-only' });
          } else if (inWinnerZone && inLoserZone) {
            score += 1;
            details.push({ key: b.key, val, verdict: 'overlap' });
          } else {
            details.push({ key: b.key, val, verdict: 'loser' });
          }
        }

        if (score > 0) {
          scored.push({ score, details, failures });
          for (const f of failures) {
            const norm = f.replace(/:.*/, '').trim();
            filterHitByScore[norm] = (filterHitByScore[norm] || 0) + score;
          }
        }
      } catch (_) {}
    }

    scored.sort((a, b) => b.score - a.score);

    // ── 4. Response ──
    const totalFiltered = filteredRows.length;
    const topPotential = scored.slice(0, 20).map(s => ({
      score: s.score,
      maxScore: bounds.length * 2,
      pct: Math.round(s.score / (bounds.length * 2) * 100),
      details: s.details,
      filters: s.failures,
    }));

    const byScore = { high: 0, medium: 0, low: 0 };
    scored.forEach(s => {
      const pct = s.score / (bounds.length * 2);
      if (pct >= 0.5) byScore.high++;
      else if (pct >= 0.3) byScore.medium++;
      else byScore.low++;
    });

    const worstFilters = Object.entries(filterHitByScore)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    const winnerRanges = {};
    for (const b of bounds) {
      winnerRanges[b.key] = { winnerMin: b.winnerMin, winnerMax: b.winnerMax, loserMin: b.loserMin, loserMax: b.loserMax };
    }

    // ── 5. Build recommendations ──
    const activeStrategy = db.prepare("SELECT config_json FROM strategies WHERE enabled = 1 LIMIT 1").get();
    const config = activeStrategy ? JSON.parse(activeStrategy.config_json) : {};

    // Map filter names to config keys and recommended new values
    const filterMap = [
      { name: 'top holder', configKey: 'max_top20_holder_percent', configVal: config.max_top20_holder_percent, isMax: true, desc: 'Max Top20' },
      { name: 'market cap min', configKey: 'min_mcap_usd', configVal: config.min_mcap_usd, isMax: false, desc: 'Min MCAP' },
      { name: 'market cap max', configKey: 'max_mcap_usd', configVal: config.max_mcap_usd, isMax: true, desc: 'Max MCAP' },
      { name: 'trending volume', configKey: 'trending_min_volume_usd', configVal: config.trending_min_volume_usd, isMax: false, desc: 'Min Vol' },
      { name: 'trending swaps', configKey: 'trending_min_swaps', configVal: config.trending_min_swaps, isMax: false, desc: 'Min Swaps' },
      { name: 'liquidity', configKey: 'min_liquidity_usd', configVal: config.min_liquidity_usd, isMax: false, desc: 'Min Liq' },
      { name: 'holders', configKey: 'min_holders', configVal: config.min_holders, isMax: false, desc: 'Min Holders' },
      { name: 'fee claim', configKey: 'min_fee_claim_sol', configVal: config.min_fee_claim_sol, isMax: false, desc: 'Fee Claim' },
    ];

    const recommendations = [];
    for (const fm of filterMap) {
      const hitData = worstFilters.find(w => w[0].toLowerCase().includes(fm.name));
      if (!hitData) continue;
      const curVal = fm.configVal;
      if (curVal == null) continue;

      // Find high-potential candidates (score >=5) rejected by this filter
      const hitCandidates = scored.filter(s =>
        s.score >= 5 && s.failures.some(f => f.toLowerCase().includes(fm.name))
      );
      if (!hitCandidates.length) continue;

      // Get the relevant metric from their details, or extract from failure message
      const detailKey = fm.name.includes('holder') ? 'top10Pct'
        : fm.name.includes('volume') ? 'volume'
        : fm.name.includes('swap') ? 'swaps'
        : fm.name.includes('liquid') ? 'liquidityUsd'
        : null;
      let values;
      if (detailKey) {
        values = hitCandidates.map(c => {
          const d = c.details.find(dd => dd.key === detailKey);
          return d ? d.val : null;
        }).filter(v => v != null);
      } else {
        // Extract first number from failure message as candidate's value
        values = hitCandidates.map(c => {
          const fail = c.failures.find(f => f.toLowerCase().includes(fm.name));
          if (!fail) return null;
          const m = fail.match(/[\d,.]+/);
          return m ? parseFloat(m[0].replace(/,/g,'')) : null;
        }).filter(v => v != null);
      }

      if (!values.length) continue;

      const sorted = [...values].sort((a,b) => a-b);
      const p20 = sorted[Math.floor(sorted.length * 0.2)];
      const p80 = sorted[Math.floor(sorted.length * 0.8)];
      // For MAX-type filters (fail when value > threshold): loosen by raising threshold → use P80
      // For MIN-type filters (fail when value < threshold): loosen by lowering threshold → use P20
      const suggest = fm.isMax ? Math.ceil(p80) : Math.floor(p20);
      if (suggest > 0 && suggest !== curVal) {
        const looser = fm.isMax ? suggest > curVal : suggest < curVal;
        recommendations.push({
          filter: fm.desc,
          current: curVal,
          suggest,
          impact: looser ? 'loosen' : 'tighten',
          candidatesLost: hitCandidates.length,
        });
      }
    }
    const loosenRecs = recommendations.filter(r => r.impact === 'loosen');

    res.json({
      totalRejected: totalFiltered,
      totalScored: scored.length,
      winners: winners.length,
      losers: losers.length,
      winnerRanges,
      distribution: byScore,
      topPotential,
      worstFilters: worstFilters.map(([name, totalScore]) => ({ filter: name, totalScore })),
      recommendations: loosenRecs,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Apply recommendations ──

const recMap = {
  // Potential section (filter field)
  'Min MCAP': 'min_mcap_usd',
  'Max MCAP': 'max_mcap_usd',
  'Max Top20': 'max_top20_holder_percent',
  'Min Vol': 'trending_min_volume_usd',
  'Min Swaps': 'trending_min_swaps',
  'Min Liq': 'min_liquidity_usd',
  'Min Holders': 'min_holders',
  'Fee Claim': 'min_fee_claim_sol',
  // Analysis section (metric field)
  'top10HolderPercent': 'max_top10_holder_percent',
  'minLiquidityUsd': 'min_liquidity_usd',
  'minHolders': 'min_holders',
  'entryMcapUsd': 'max_mcap_usd',
  'minSizeSol': 'position_size_sol',
  'trendingVolumeUsd': 'trending_min_volume_usd',
  'trendingSwaps': 'trending_min_swaps',
  'trailingPercent': 'trailing_percent',
};

app.post('/api/apply-recommendations', (req, res) => {
  try {
    const { recommendations } = req.body || {};
    if (!Array.isArray(recommendations) || !recommendations.length) {
      return res.status(400).json({ error: 'No recommendations to apply' });
    }

    const activeStrategy = db.prepare("SELECT id, config_json FROM strategies WHERE enabled = 1 LIMIT 1").get();
    if (!activeStrategy) {
      return res.status(404).json({ error: 'No active strategy found' });
    }

    const config = JSON.parse(activeStrategy.config_json || '{}');
    const applied = [];

    for (const rec of recommendations) {
      const key = recMap[rec.filter] || recMap[rec.metric];
      if (!key) continue;
      if (config[key] === undefined) continue;
      config[key] = rec.suggest ?? rec.value;
      applied.push(rec.filter || rec.metric);
    }

    if (!applied.length) {
      return res.status(400).json({ error: 'No matching config keys found' });
    }

    openDb(false);
    try {
      db.prepare("UPDATE strategies SET config_json = ? WHERE id = ?").run(JSON.stringify(config), activeStrategy.id);
    } finally {
      openDb(true);
    }

    res.json({ success: true, applied, config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Verify page password ──
const PAGE_PASSWORD = 'GyvdhH66g3%5b';

app.post('/api/verify-password', (req, res) => {
  const { password } = req.body || {};
  if (password === PAGE_PASSWORD) {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});

// ── Close a position (manual sell) ──
app.post('/api/positions/:id/close', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid position ID' });

    const position = db.prepare(`
      SELECT id, mint, status, execution_mode, size_sol, entry_mcap, entry_price,
             token_amount_raw, token_amount_est,
             current_pnl_sol, current_pnl_percent
      FROM dry_run_positions WHERE id = ?
    `).get(id);
    if (!position) return res.status(404).json({ error: 'Position not found' });
    if (position.status === 'closed') return res.status(400).json({ error: 'Position already closed' });

    if (position.execution_mode === 'live') {
      if (!position.token_amount_raw && !position.token_amount_est) {
        return res.status(400).json({ error: 'No token amount to sell' });
      }
      try {
        const amount = position.token_amount_raw || position.token_amount_est;
        const result = await executeJupiterSwap({
          inputMint: position.mint,
          outputMint: WSOL_MINT,
          amount,
        });
        const outputSol = Number(result.outputAmount) / 1e9;
        const sizeSol = Number(position.size_sol);
        let pnlSol = outputSol - sizeSol;
        let pnlPercent = sizeSol > 0 ? (outputSol / sizeSol - 1) * 100 : 0;
        let exitPrice = sizeSol > 0 ? (position.entry_price * outputSol / sizeSol) : position.entry_price;
        let exitMcap = null;
        openDb(false);
        try {
          db.prepare(`
            UPDATE dry_run_positions
            SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?,
                exit_reason = 'MANUAL', pnl_percent = ?, pnl_sol = ?
            WHERE id = ?
          `).run(now(), exitPrice, exitMcap, pnlPercent, pnlSol, position.id);
          db.prepare(`
            INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
            VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, 'MANUAL', ?)
            `).run(position.id, position.mint, now(), exitPrice, exitMcap,
            sizeSol, position.token_amount_raw || position.token_amount_est,
            JSON.stringify({ pnlPercent, pnlSol, outputSol, sizeSol, signature: result.signature, closedAt: new Date().toISOString() }));
        } finally {
          openDb(true);
        }
        return res.json({ success: true, id, pnlPercent, pnlSol, signature: result.signature });
      } catch (err) {
        console.error(`Live close swap failed:`, err);
        return res.status(500).json({ error: `Swap failed: ${err.message}` });
      }
    }

    let price = position.entry_price;
    let mcap = position.entry_mcap;
    let pnlPercent = position.current_pnl_percent ?? 0;
    let pnlSol = position.current_pnl_sol ?? 0;
    try {
      const url = new URL('https://datapi.jup.ag/v1/assets/search');
      url.searchParams.set('query', position.mint);
      const jres = await axios.get(url.toString(), { timeout: 10_000 });
      const rows = Array.isArray(jres.data) ? jres.data : [];
      const asset = rows.find(row => row?.id === position.mint) || rows[0] || null;
      if (asset) {
        const p = Number(asset.usdPrice);
        const m = Number(asset.mcap ?? asset.fdv);
        if (p > 0) price = p;
        if (m > 0) mcap = m;
        if (m > 0 && Number(position.entry_mcap) > 0) {
          pnlPercent = (m / Number(position.entry_mcap) - 1) * 100;
          pnlSol = Number(position.size_sol) * pnlPercent / 100;
        }
      }
    } catch (err) {
      console.error(`Close trade asset fetch failed: ${err.message}`);
    }

    openDb(false);
    try {
      db.prepare(`
        UPDATE dry_run_positions
        SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?,
            exit_reason = 'MANUAL', pnl_percent = ?, pnl_sol = ?
        WHERE id = ?
      `).run(now(), price, mcap, pnlPercent, pnlSol, position.id);

      db.prepare(`
        INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
        VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, 'MANUAL', ?)
      `).run(position.id, position.mint, now(), price, mcap,
        Number(position.size_sol), position.token_amount_est || position.token_amount_raw || null,
        JSON.stringify({ pnlPercent, pnlSol, closedAt: new Date().toISOString() }));
    } finally {
      openDb(true);
    }

    res.json({ success: true, id, pnlPercent, pnlSol });
  } catch (err) {
    console.error('Close trade error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// Health check — responds immediately even if DB is busy
app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

initLiveExecution();

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Charon Trade Viewer running at http://0.0.0.0:${PORT}`);
});

// Keepalive: prevent OS page cache eviction + keep WAL trimmed
const KEEPALIVE_MS = 15_000;
const keepaliveTimer = setInterval(() => {
  try {
    db.prepare('SELECT 1').get();
    db.pragma('wal_checkpoint(PASSIVE)');
  } catch (err) {
    console.error('Keepalive error:', err);
  }
}, KEEPALIVE_MS);

// Graceful shutdown — WAL checkpoint + clean close = faster next startup
function shutdown() {
  console.log('\nShutting down...');
  clearInterval(keepaliveTimer);
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch(e) {}
  try { db.close(); } catch(e) {}
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Prevent crash on uncaught errors — log and keep serving
process.on('uncaughtException', err => {
  console.error('UNCAUGHT EXCEPTION:', err);
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch(e) {}
  try { db.close(); } catch(e) {}
  server.close(() => process.exit(1));
});
process.on('unhandledRejection', (reason, p) => {
  console.error('UNHANDLED REJECTION:', reason);
});
