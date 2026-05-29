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
function openDb() {
  if (db) { try { db.close(); } catch {} }
  db = new Database(dbPath, { readonly: false });
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('journal_size_limit = 8388608');
  db.pragma('wal_autocheckpoint = 1000');
  db.pragma('busy_timeout = 15000');
  db.pragma('cache_size = -24000');
  db.pragma('temp_store = MEMORY');
  db.pragma('mmap_size = 26843545600');
}
openDb();

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
      try { openDb(); } catch {}
    }
  }
  next();
});

app.get('/api/summary', (req, res) => {
  try {
    const mode = req.query.mode || '';
    const modeClause = mode ? "AND execution_mode = ?" : "";
    const modeParams = mode ? [mode] : [];

    const closed = db.prepare(`
      SELECT
        COUNT(*) as closedCount,
        COALESCE(SUM(pnl_sol), 0) as totalPnlSol,
        COALESCE(AVG(pnl_percent), 0) as avgPnlPercent,
        COALESCE(SUM(size_sol), 0) as totalSizeSol,
        SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN pnl_sol < 0 THEN 1 ELSE 0 END) as losses
      FROM dry_run_positions WHERE status = 'closed' ${modeClause}
    `).get(...modeParams);

    const open = db.prepare(`SELECT COUNT(*) as c FROM dry_run_positions WHERE status = 'open' ${modeClause}`).get(...modeParams);
    const total = db.prepare(`SELECT COUNT(*) as c FROM dry_run_positions ${modeClause ? 'WHERE ' + modeClause.replace('AND ', '') : ''}`).get(...modeParams);

    const best = db.prepare(`SELECT symbol, pnl_sol FROM dry_run_positions WHERE status = 'closed' AND pnl_sol IS NOT NULL ${modeClause} ORDER BY pnl_sol DESC LIMIT 1`).get(...modeParams);
    const worst = db.prepare(`SELECT symbol, pnl_sol FROM dry_run_positions WHERE status = 'closed' AND pnl_sol IS NOT NULL ${modeClause} ORDER BY pnl_sol ASC LIMIT 1`).get(...modeParams);

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
      mode: mode || 'all',
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

// Delete trades by ID range endpoint - deletes trades for dry run positions only within ID range
app.post('/api/trades/delete-range', (req, res) => {
  try {
    const { startId, endId } = req.body;
    
    // Validate input
    if (typeof startId !== 'number' || !isFinite(startId) || 
        typeof endId !== 'number' || !isFinite(endId)) {
      return res.status(400).json({ error: 'Invalid startId or endId. Both must be finite numbers.' });
    }
    
    const start = Math.floor(startId);
    const end = Math.floor(endId);
    
    if (start > end) {
      return res.status(400).json({ error: 'startId must be less than or equal to endId' });
    }
    
    if (start < 1) {
      return res.status(400).json({ error: 'startId must be >= 1' });
    }
    
    // First get the trades to return them before deletion (only for dry run positions)
    const trades = db.prepare(`
      SELECT t.id, t.side, t.at_ms, t.price, t.mcap, t.size_sol, t.reason, t.payload_json
      FROM dry_run_trades t
      JOIN dry_run_positions p ON t.position_id = p.id
      WHERE t.id BETWEEN ? AND ?
        AND p.execution_mode = 'dry_run'
      ORDER BY t.id ASC
    `).all(start, end);

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
      };
    });

    // Actually delete the trades
    const result = db.prepare(`
      DELETE FROM dry_run_trades 
      WHERE id BETWEEN ? AND ?
        AND position_id IN (
          SELECT id FROM dry_run_positions WHERE execution_mode = 'dry_run'
        )
    `).run(start, end);

    res.json({
      message: `Successfully deleted ${result.changes} trade(s) with IDs from ${start} to ${end} (dry run positions only)`,
      deletedCount: result.changes,
      startId: start,
      endId: end,
      trades: formatted
    });
  } catch (err) {
    console.error('Delete trades by range error:', err);
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
    const mode = req.query.mode || '';
    const modeClause = mode ? "AND p.execution_mode = ?" : "";
    const modeParams = mode ? [mode] : [];

    const rows = db.prepare(`
       SELECT p.pnl_sol, p.pnl_percent, p.exit_reason, p.entry_mcap, p.size_sol, p.min_pnl_sol, p.max_pnl_sol, p.sl_percent, p.tp_percent, p.trailing_percent, p.opened_at_ms, p.closed_at_ms,
             c.candidate_json
      FROM dry_run_positions p
      LEFT JOIN candidates c ON p.candidate_id = c.id
      WHERE p.status = 'closed' AND c.candidate_json IS NOT NULL ${modeClause}
      ORDER BY p.opened_at_ms DESC
      LIMIT 2000
    `).all(...modeParams);

    const fmt = (v) => v != null && Number.isFinite(v) ? Number(v) : null;

    const analyzed = rows.map(r => {
      const cj = JSON.parse(r.candidate_json);
      const metrics = cj.metrics || {};
      const holders = cj.holders || { holders: [] };
      const top10 = holders.holders.slice(0, 10).reduce((s, h) => s + (h.percent || 0), 0);
      return {
        pnl_sol: fmt(r.pnl_sol),
        pnl_percent: fmt(r.pnl_percent),
        exit_reason: r.exit_reason || 'unknown',
        entry_mcap: fmt(r.entry_mcap),
        size_sol: fmt(r.size_sol),
        min_pnl_sol: fmt(r.min_pnl_sol),
        max_pnl_sol: fmt(r.max_pnl_sol),
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

    // ════════════════════════════════════════════════════════════════
    // LOSS vs WIN ANALYSIS (compare distributions)
    // ════════════════════════════════════════════════════════════════
    const lossThreshold = -30;
    const winThreshold = 30;
    const lossTrades = analyzed.filter(a => a.pnl_percent != null && a.pnl_percent <= lossThreshold);
    const winTrades = analyzed.filter(a => a.pnl_percent != null && a.pnl_percent >= winThreshold);
    const lossAnalysis = { threshold: lossThreshold, count: lossTrades.length, commonConditions: [], recommendations: [] };
    const winAnalysis = { threshold: winThreshold, count: winTrades.length, commonConditions: [], recommendations: [] };

    function analyzeGroup(trades, target, opposing, analysis, isLoss) {
      if (trades.length < 3) return;
      const fields = [
        { key: 'liquidityUsd', label: 'Liq', dirLow: 'le', dirHigh: 'ge' },
        { key: 'holderCount', label: 'Holders', dirLow: 'le', dirHigh: 'ge' },
        { key: 'top10Pct', label: 'Top10%', dirLow: 'ge', dirHigh: 'le' },
        { key: 'trendingVolumeUsd', label: 'Volume', dirLow: 'le', dirHigh: 'ge' },
        { key: 'trendingSwaps', label: 'Swaps', dirLow: 'le', dirHigh: 'ge' },
      ];
      const fmt = (key, v) => {
        if (key === 'liquidityUsd' || key === 'trendingVolumeUsd') return v >= 1000 ? '$'+(v/1000).toFixed(0)+'K' : '$'+v.toFixed(0);
        if (key === 'top10Pct') return v.toFixed(1)+'%';
        return String(v);
      };
      const configKeyMap = {
        'Liq': { key: 'min_liquidity_usd', isMax: false },
        'Holders': { key: 'min_holders', isMax: false },
        'Top10%': { key: 'max_top10_holder_percent', isMax: true },
        'Volume': { key: 'trending_min_volume_usd', isMax: false },
        'Swaps': { key: 'trending_min_swaps', isMax: false },
      };

      for (const f of fields) {
        const tVals = trades.map(a => a[f.key]).filter(v => v != null && Number.isFinite(v));
        const oVals = opposing.map(a => a[f.key]).filter(v => v != null && Number.isFinite(v));
        if (!tVals.length) continue;

        // Loss analysis: test "bad" direction (dirLow). Win analysis: test "good" direction (dirHigh)
        const testDirs = isLoss ? ['low'] : ['high'];
        for (const dir of testDirs) {
          const d = dir === 'low' ? f.dirLow : f.dirHigh;
          const allVals = [...tVals].sort((a, b) => a - b);

          // Try thresholds at multiple percentiles (50, 60, 70, 75, 80, 90)
          let best = { diff: -Infinity, thresh: null, tHit: 0, tPct: 0, oHit: 0, oPct: 0 };
          for (const pct of [50, 60, 70, 75, 80, 90]) {
            const idx = Math.floor(allVals.length * pct / 100);
            const thresh = allVals[Math.min(idx, allVals.length - 1)];
            const tHit = tVals.filter(v => d === 'le' ? v <= thresh : v >= thresh).length;
            const tPct = tHit / tVals.length * 100;
            if (tPct < 55 || tHit < 2) continue;
            const oHit = oVals.length ? oVals.filter(v => d === 'le' ? v <= thresh : v >= thresh).length : 0;
            const oPct = oVals.length ? oHit / oVals.length * 100 : 0;
            const diff = tPct - oPct;
            if (diff > best.diff) { best = { diff, thresh, tHit, tPct, oHit, oPct }; }
          }

          if (best.diff >= 10 && best.thresh != null) {
            analysis.commonConditions.push({
              field: f.key,
              label: f.label,
              direction: d === 'le' ? '\u2264' : '\u2265',
              threshold: best.thresh,
              formatted: fmt(f.key, best.thresh),
              captureCount: best.tHit,
              capturePct: rnd(best.tPct),
              opposingCapturePct: rnd(best.oPct),
              diff: rnd(best.diff),
            });

            // Generate config recommendation (only for loss analysis)
            const cfgKey = configKeyMap[f.label];
            if (cfgKey && isLoss) {
              const curVal = activeCfg[cfgKey.key];
              let suggest;
              if (cfgKey.isMax) {
                suggest = Math.min(curVal ?? 100, best.thresh);
              } else {
                suggest = Math.max(curVal ?? 0, best.thresh);
              }
              if (suggest !== curVal && suggest > 0) {
                analysis.recommendations.push({
                  metric: f.label,
                  current: curVal,
                  suggest,
                  reason: `${best.tHit}/${trades.length} loss (${rnd(best.tPct)}%) vs ${best.oHit}/${opposing.length} win (${rnd(best.oPct)}%) punya ${f.label} ${d === 'le' ? '\u2264' : '\u2265'} ${fmt(f.key, best.thresh)}`,
                });
              }
            }
          }
        }
      }
    }

    analyzeGroup(lossTrades, lossTrades, winTrades, lossAnalysis, true);
    analyzeGroup(winTrades, winTrades, lossTrades, winAnalysis, false);

    // ════════════════════════════════════════════════════════════════
    // SL OPTIMIZATION
    // ════════════════════════════════════════════════════════════════
    const slOpt = { slByProfit: null, slByLoss: null };

    // SL BY PROFIT: closed positions yg sempat floating loss (min_pnl_sol < 0) tapi akhirnya profit (pnl_sol > 0)
    // floating loss terendah (paling negatif) = batas atas SL. SL sebaiknya tidak lebih rendah dari itu,
    // agar posisi yg masih bisa balik profit tidak terpotong.
    const recoveredRows = db.prepare(`
      SELECT min_pnl_sol, size_sol, pnl_percent, pnl_sol, symbol
      FROM dry_run_positions
      WHERE status = 'closed' AND min_pnl_sol IS NOT NULL AND min_pnl_sol < 0 AND pnl_sol > 0
        AND size_sol > 0
    `).all();

    if (recoveredRows.length > 0) {
      const minPcts = recoveredRows.map(r => r.min_pnl_sol / r.size_sol * 100);
      const lowestMinPct = Math.min(...minPcts);
      const highestMinPct = Math.max(...minPcts);
      const sortedPcts = [...minPcts].sort((a, b) => a - b);
      const p50 = sortedPcts[Math.floor(sortedPcts.length * 0.5)];

      slOpt.slByProfit = {
        count: recoveredRows.length,
        lowestFloatingPct: rnd(lowestMinPct),
        highestFloatingPct: rnd(highestMinPct),
        medianFloatingPct: rnd(p50),
        slUpperBound: rnd(lowestMinPct),
        boundDesc: `SL jangan lebih rendah dari ${rnd(lowestMinPct)}% (recovered trade terdalam)`,
      };
    }

    // SL BY LOSS: open > 24h (stale) + closed dgn loss besar (pnl_percent < -30%)
    // — dianggap tdk akan balik profit. floating/realized loss terbesar (paling kecil % kerugian) = batas atas SL.
    // SL sebaiknya tidak lebih kecil dari itu agar posisi yg tidak akan balik dipotong sebelum rugi lebih besar.
    const staleRows = db.prepare(`
      SELECT current_pnl_percent AS loss_pct, symbol
      FROM dry_run_positions
      WHERE status = 'open' AND current_pnl_sol < 0 AND (? - opened_at_ms) > 86400000
    `).all(Date.now());

    const bigLossRows = db.prepare(`
      SELECT pnl_percent AS loss_pct, symbol
      FROM dry_run_positions
      WHERE status = 'closed' AND pnl_sol IS NOT NULL AND pnl_sol < 0 AND pnl_percent IS NOT NULL AND pnl_percent < -30
    `).all();

    const lossRows = [...staleRows, ...bigLossRows];
    if (lossRows.length > 0) {
      const lossPcts = lossRows.map(r => r.loss_pct).filter(v => v != null && v < 0);
      if (lossPcts.length > 0) {
        const highestLossPct = Math.max(...lossPcts);
        const lowestLossPct = Math.min(...lossPcts);
        const staleCount = staleRows.length;
        const bigLossCount = bigLossRows.length;
        slOpt.slByLoss = {
          staleCount,
          bigLossCount,
          highestLossPct: rnd(highestLossPct),
          lowestLossPct: rnd(lowestLossPct),
          slUpperBound: rnd(highestLossPct),
          boundDesc: `SL jangan lebih kecil dari ${rnd(highestLossPct)}% (${staleCount} stale >24h + ${bigLossCount} closed <-30%)`,
        };
      }
    }

    // ════════════════════════════════════════════════════════════════
    // TRAILING OPTIMIZATION
    // ════════════════════════════════════════════════════════════════
    const trailOpt = { activate: null, trailingPct: null };

    // Hitung peak_pnl_pct untuk tiap closed trade
    const withPeak = analyzed.filter(a => a.size_sol > 0 && a.max_pnl_sol != null);
    const peakPcts = withPeak.map(a => (a.max_pnl_sol / a.size_sol) * 100);
    const winnersWithPeak = withPeak.filter(a => a.pnl_sol > 0 && a.pnl_percent != null);

    if (peakPcts.length >= 5) {
      const sortedPeaks = [...peakPcts].sort((a, b) => a - b);
      const p25 = sortedPeaks[Math.floor(sortedPeaks.length * 0.25)];
      const p50 = sortedPeaks[Math.floor(sortedPeaks.length * 0.5)];
      const p75 = sortedPeaks[Math.floor(sortedPeaks.length * 0.75)];

      // Activate distribution: candidate thresholds
      const candidates = [2, 3, 5, 8, 10, 15, 20, 30, 50];
      const activateScores = candidates.map(pct => {
        const activated = withPeak.filter(a => (a.max_pnl_sol / a.size_sol) * 100 >= pct);
        const winRate = activated.length ? activated.filter(a => a.pnl_sol > 0).length / activated.length * 100 : 0;
        return { threshold: pct, count: activated.length, winRate: rnd(winRate) };
      });

      // Cari threshold optimal: minimal 50 trades, win rate tertinggi
      const bestActivate = activateScores.filter(a => a.count >= 50).sort((a, b) => b.winRate - a.winRate)[0]
        || activateScores.filter(a => a.count >= 20).sort((a, b) => b.winRate - a.winRate)[0];

      // Retracement analysis for winners
      const retracePcts = winnersWithPeak.map(a => {
        const peak = (a.max_pnl_sol / a.size_sol) * 100;
        return (a.pnl_percent - peak) / (1 + peak / 100);
      }).filter(v => v < 0);

      const sortedRetrace = [...retracePcts].sort((a, b) => a - b);
      const rCount = sortedRetrace.length;

      trailOpt.activate = {
        peakDistribution: {
          p25: rnd(p25),
          p50: rnd(p50),
          p75: rnd(p75),
        },
        activateScores,
        suggestedActivate: bestActivate ? bestActivate.threshold : null,
        description: `Aktifkan trailing di +${bestActivate ? bestActivate.threshold : '?'}% (win rate ${bestActivate ? bestActivate.winRate : '?'}% untuk trade yg mencapai level ini). 25% trade punya peak ≤ ${rnd(p25)}%, 50% ≤ ${rnd(p50)}%, 75% ≤ ${rnd(p75)}%.`,
      };

      if (rCount >= 5) {
        const rPct25 = sortedRetrace[Math.floor(rCount * 0.25)];
        const rPct50 = sortedRetrace[Math.floor(rCount * 0.5)];
        const rPct75 = sortedRetrace[Math.floor(rCount * 0.75)];

        const tight = Math.abs(rPct75);
        const balanced = Math.abs(rPct50);
        const loose = Math.abs(rPct25);

        trailOpt.trailingPct = {
          retraceDistribution: {
            p25: rnd(rPct25),
            p50: rnd(rPct50),
            p75: rnd(rPct75),
          },
          suggestions: {
            tight: rnd(tight),
            balanced: rnd(balanced),
            loose: rnd(loose),
          },
          description: `Dari ${rCount} closed winners, retracement from peak: 25% ≤ ${rnd(rPct25)}pp, median ${rnd(rPct50)}pp, 75% ≤ ${rnd(rPct75)}pp. Trailing: ketat ${rnd(tight)}%, sedang ${rnd(balanced)}%, longgar ${rnd(loose)}%.`,
        };
      }
    }

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
      lossAnalysis,
      winAnalysis,
      slOptimization: slOpt,
      trailingOptimization: trailOpt,
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
    const mode = req.query.mode || '';
    // ── Helpers ──
    function smartScoreCandidate(metrics, holders, signals, trending) {
      const top10 = holders.holders
        ? holders.holders.slice(0, 10).reduce((s, hh) => s + (hh.percent || 0), 0)
        : null;
      const hCount = holders.count || Number(metrics.holderCount) || 0;
      const liq = Number(metrics.liquidityUsd) || 0;
      const mcap = Number(metrics.marketCapUsd) || 0;
      const vol = Number(metrics.trendingVolumeUsd) || 0;
      const swaps = Number(metrics.trendingSwaps) || 0;
      const routeSig = (signals.route || '').split('_').filter(Boolean).length;
      const maxHolder = holders.maxHolderPercent;
      const rug = trending?.rug_ratio;
      const bundle = trending?.bundler_rate;

      // Holder quality (0-25): hCount + top10 balance
      let holderScore = 0;
      if (hCount >= 500) holderScore = 25;
      else if (hCount >= 200) holderScore = 20;
      else if (hCount >= 100) holderScore = 15;
      else if (hCount >= 50) holderScore = 10;
      else if (hCount >= 20) holderScore = 5;
      // Penalty if top10 is too extreme
      if (top10 != null) {
        if (top10 > 80) holderScore = Math.max(0, holderScore - 10);
        else if (top10 > 60) holderScore = Math.max(0, holderScore - 5);
        else if (top10 >= 20 && top10 <= 50) holderScore = Math.min(25, holderScore + 3);
      }
      // Penalty if one whale dominates
      if (maxHolder != null && maxHolder > 30) holderScore = Math.max(0, holderScore - 8);

      // Volume quality (0-25): organic activity estimation
      let volScore = 0;
      if (vol > 0 && swaps > 0) {
        const avgTrade = vol / swaps;
        if (avgTrade < 50) volScore = 25;       // many small trades = organic
        else if (avgTrade < 200) volScore = 20;
        else if (avgTrade < 1000) volScore = 12;
        else volScore = 5;                       // whale trades
        // Volume magnitude bonus
        if (vol >= 50000) volScore = Math.min(25, volScore + 5);
        else if (vol >= 10000) volScore = Math.min(25, volScore + 3);
      } else if (vol > 0) {
        volScore = 8; // volume but no swaps data
      }

      // Liquidity safety (0-20): liq / mcap ratio
      let liqScore = 0;
      if (liq > 0 && mcap > 0) {
        const ratio = liq / mcap;
        if (ratio >= 0.3) liqScore = 20;
        else if (ratio >= 0.15) liqScore = 15;
        else if (ratio >= 0.05) liqScore = 10;
        else if (ratio >= 0.02) liqScore = 5;
      } else if (liq > 10000) {
        liqScore = 8; // absolute liquidity floor
      }

      // Signal diversity (0-15): more sources = higher confidence
      const sigScore = Math.min(15, routeSig * 8);

      // Rug safety (0-15): low rug ratio + low bundler rate
      let rugScore = 10;
      if (rug != null) {
        if (rug <= 0.1) rugScore += 5;
        else if (rug <= 0.3) rugScore += 2;
        else if (rug > 0.5) rugScore -= 5;
      }
      if (bundle != null) {
        if (bundle <= 0.1) rugScore += 3;
        else if (bundle <= 0.3) rugScore += 1;
        else if (bundle > 0.5) rugScore -= 3;
      }
      rugScore = Math.max(0, Math.min(15, rugScore));

      const total = holderScore + volScore + liqScore + sigScore + rugScore;

      return {
        score: total,
        maxScore: 100,
        pct: Math.round(total),
        details: {
          holderScore: { val: holderScore, desc: hCount + ' holder' + (top10 != null ? ', Top10=' + top10.toFixed(1) + '%' : '') },
          volScore: { val: volScore, desc: (vol >= 1000 ? '$' + (vol/1000).toFixed(0) + 'K' : '$' + vol.toFixed(0)) + ' vol / ' + (swaps || 0) + ' swap' },
          liqScore: { val: liqScore, desc: (liq >= 1000 ? '$' + (liq/1000).toFixed(0) + 'K' : '$' + liq.toFixed(0)) + ' likuiditas' + (mcap > 0 ? ' / MCAP $' + (mcap/1000).toFixed(0) + 'K' : '') },
          sigScore: { val: sigScore, desc: routeSig + ' sumber sinyal' },
          rugScore: { val: rugScore, desc: 'Rug=' + (rug != null ? rug.toFixed(2) : '?') + ' Bundle=' + (bundle != null ? bundle.toFixed(2) : '?') },
        },
      };
    }

    function savedWalletScoreCandidate(swe) {
      const count = swe?.holderCount ?? 0;
      const checked = swe?.checked ?? 0;
      let score = 0;
      if (count >= 5) score = 100;
      else if (count >= 3) score = 80;
      else if (count >= 2) score = 60;
      else if (count >= 1) score = 40;
      // Bonus for high ratio of saved holders to checked
      if (checked > 0 && count > 0) {
        const ratio = count / checked;
        if (ratio > 0.5) score = Math.min(100, score + 15);
        else if (ratio > 0.2) score = Math.min(100, score + 5);
      }
      return {
        score,
        maxScore: 100,
        pct: score,
        count,
        checked,
      };
    }

    // ── 1. Fetch all filtered candidates ──
    const filteredRows = db.prepare(`
      SELECT c.candidate_json, c.filter_result_json
      FROM candidates c
      WHERE c.status = 'filtered' AND c.candidate_json IS NOT NULL
      ORDER BY c.created_at_ms DESC
    `).all();

    const totalFiltered = filteredRows.length;
    const smartScored = [];
    const savedWalletScored = [];
    const parsedCandidates = [];

    for (const r of filteredRows) {
      try {
        const cj = JSON.parse(r.candidate_json);
        const fr = JSON.parse(r.filter_result_json);
        const metrics = cj.metrics || {};
        const holders = cj.holders || {};
        const signals = cj.signals || {};
        const trending = cj.trending || null;
        const swe = cj.savedWalletExposure || {};

        const sm = smartScoreCandidate(metrics, holders, signals, trending);
        const sw = savedWalletScoreCandidate(swe);

        smartScored.push({
          score: sm.score,
          maxScore: 100,
          pct: sm.pct,
          details: sm.details,
          filters: fr.failures || [],
        });

        savedWalletScored.push({
          score: sw.score,
          maxScore: 100,
          pct: sw.pct,
          count: sw.count,
          checked: sw.checked,
          filters: fr.failures || [],
        });

        parsedCandidates.push({
          cj, fr, metrics, holders, signals, trending, swe,
        });
      } catch (_) {}
    }

    smartScored.sort((a, b) => b.score - a.score);
    savedWalletScored.sort((a, b) => b.score - a.score);

    const topSmart = smartScored.slice(0, 15).map(s => ({
      score: s.score,
      maxScore: 100,
      pct: s.pct,
      details: s.details,
      filters: s.filters,
    }));

    const topSaved = savedWalletScored.filter(s => s.score > 0).slice(0, 15).map(s => ({
      score: s.score,
      maxScore: 100,
      pct: s.pct,
      count: s.count,
      checked: s.checked,
      filters: s.filters,
    }));

    const swCountWithOverlap = savedWalletScored.filter(s => s.score > 0).length;

    // ── 2. Trade-based scoring (if data available) ──
    const tradeClause = mode ? "AND p.execution_mode = ?" : "";
    const tradeParams = mode ? [mode] : [];
    const tradeRows = db.prepare(`
      SELECT p.pnl_sol, p.entry_mcap, c.candidate_json
      FROM dry_run_positions p
      LEFT JOIN candidates c ON p.candidate_id = c.id
      WHERE p.status = 'closed' AND c.candidate_json IS NOT NULL ${tradeClause}
    `).all(...tradeParams);

    const fmtNum = v => v != null && Number.isFinite(v) ? Number(v) : null;

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
      const pnl = fmtNum(r.pnl_sol);
      if (pnl == null) continue;
      try {
        const cj = JSON.parse(r.candidate_json);
        const m = extractMetrics(cj);
        (pnl > 0 ? winners : losers).push(m);
      } catch (_) {}
    }

    let tradeBasedAvailable = false;
    let bounds = [], winnerRanges = {}, tradeScored = [], byScore = {}, worstFilters = [], topPotential = [], recommendations = [], loosenRecs = [];

    if (winners.length && losers.length) {
      tradeBasedAvailable = true;

      bounds = ['top10Pct', 'liquidityUsd', 'holderCount', 'volume', 'swaps'].map(key => {
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

      const filterHitByScore = {};

      for (const pc of parsedCandidates) {
        const metrics = extractMetrics(pc.cj);
        const failures = pc.fr.failures || [];

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
          tradeScored.push({ score, details, failures });
          for (const f of failures) {
            const norm = f.replace(/:.*/, '').trim();
            filterHitByScore[norm] = (filterHitByScore[norm] || 0) + score;
          }
        }
      }

      tradeScored.sort((a, b) => b.score - a.score);

      topPotential = tradeScored.slice(0, 20).map(s => ({
        score: s.score,
        maxScore: bounds.length * 2,
        pct: Math.round(s.score / (bounds.length * 2) * 100),
        details: s.details,
        filters: s.failures,
      }));

      byScore = { high: 0, medium: 0, low: 0 };
      tradeScored.forEach(s => {
        const pct = s.score / (bounds.length * 2);
        if (pct >= 0.5) byScore.high++;
        else if (pct >= 0.3) byScore.medium++;
        else byScore.low++;
      });

      worstFilters = Object.entries(filterHitByScore)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

      for (const b of bounds) {
        winnerRanges[b.key] = { winnerMin: b.winnerMin, winnerMax: b.winnerMax, loserMin: b.loserMin, loserMax: b.loserMax };
      }

      // ── Build recommendations ──
      const activeStrategy = db.prepare("SELECT config_json FROM strategies WHERE enabled = 1 LIMIT 1").get();
      const config = activeStrategy ? JSON.parse(activeStrategy.config_json) : {};

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

      for (const fm of filterMap) {
        const hitData = worstFilters.find(w => w[0].toLowerCase().includes(fm.name));
        if (!hitData) continue;
        const curVal = fm.configVal;
        if (curVal == null) continue;

        const hitCandidates = tradeScored.filter(s =>
          s.score >= 5 && s.failures.some(f => f.toLowerCase().includes(fm.name))
        );
        if (!hitCandidates.length) continue;

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
          values = hitCandidates.map(c => {
            const fail = c.failures.find(f => f.toLowerCase().includes(fm.name));
            if (!fail) return null;
            const m = fail.match(/[\d,.]+/);
            return m ? parseFloat(m[0].replace(/,/g, '')) : null;
          }).filter(v => v != null);
        }

        if (!values.length) continue;

        const sorted = [...values].sort((a, b) => a - b);
        const p20 = sorted[Math.floor(sorted.length * 0.2)];
        const p80 = sorted[Math.floor(sorted.length * 0.8)];
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
      loosenRecs = recommendations.filter(r => r.impact === 'loosen');
    }

    // ── Smart-score-based recommendations fallback ──
    if (!tradeBasedAvailable) {
      const filterMap = [
        { name: 'top holder', key: 'max_top20_holder_percent', isMax: true, desc: 'Max Top20' },
        { name: 'market cap min', key: 'min_mcap_usd', isMax: false, desc: 'Min MCAP' },
        { name: 'market cap max', key: 'max_mcap_usd', isMax: true, desc: 'Max MCAP' },
        { name: 'trending volume', key: 'trending_min_volume_usd', isMax: false, desc: 'Min Vol' },
        { name: 'trending swaps', key: 'trending_min_swaps', isMax: false, desc: 'Min Swaps' },
        { name: 'liquidity', key: 'min_liquidity_usd', isMax: false, desc: 'Min Liq' },
        { name: 'holders', key: 'min_holders', isMax: false, desc: 'Min Holders' },
        { name: 'fee claim', key: 'min_fee_claim_sol', isMax: false, desc: 'Fee Claim' },
        { name: 'top10 holder sum', key: 'max_top10_holder_percent', isMax: true, desc: 'Max Top10' },
      ];
      loosenRecs = [];
      const blockedByFilter = {};

      for (const s of smartScored) {
        if (s.pct < 45) continue;
        for (const f of s.filters) {
          const norm = f.replace(/:.*/, '').trim();
          if (!blockedByFilter[norm]) blockedByFilter[norm] = { count: 0, values: [] };
          blockedByFilter[norm].count++;
          const m = f.match(/[\d,.]+/);
          if (m) blockedByFilter[norm].values.push(parseFloat(m[0].replace(/,/g, '')));
        }
      }

      const activeCfg = db.prepare("SELECT config_json FROM strategies WHERE enabled = 1 LIMIT 1").get();
      const config = activeCfg ? JSON.parse(activeCfg.config_json) : {};

      for (const fm of filterMap) {
        const entry = Object.entries(blockedByFilter).find(([name]) => name.toLowerCase().includes(fm.name));
        if (!entry) continue;
        const [, data] = entry;
        const curVal = config[fm.key];
        if (curVal == null || !data.values.length) continue;

        const sorted = [...data.values].sort((a, b) => a - b);
        const suggest = fm.isMax ? Math.ceil(sorted[Math.floor(sorted.length * 0.8)]) : Math.floor(sorted[Math.floor(sorted.length * 0.2)]);
        if (suggest > 0 && suggest !== curVal) {
          const looser = fm.isMax ? suggest > curVal : suggest < curVal;
          if (looser) {
            loosenRecs.push({
              filter: fm.desc,
              current: curVal,
              suggest,
              impact: 'loosen',
              candidatesLost: data.count,
            });
          }
        }
      }
    }

    res.json({
      totalRejected: totalFiltered,
      tradeBasedAvailable,
      winners: winners.length,
      losers: losers.length,
      winnerRanges,
      distribution: byScore,
      topPotential,
      worstFilters: worstFilters.map(([name, totalScore]) => ({ filter: name, totalScore })),
      recommendations: loosenRecs,
      // New: always-available scores
      smartScore: {
        top: topSmart,
        scoredCount: smartScored.length,
        highCount: smartScored.filter(s => s.pct >= 60).length,
        mediumCount: smartScored.filter(s => s.pct >= 35 && s.pct < 60).length,
        lowCount: smartScored.filter(s => s.pct < 35).length,
      },
      savedWalletScore: {
        top: topSaved,
        withOverlap: swCountWithOverlap,
        totalChecked: smartScored.length,
      },
      mode: mode || 'all',
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
  'Max Top10': 'max_top10_holder_percent',
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

    db.prepare("UPDATE strategies SET config_json = ? WHERE id = ?").run(JSON.stringify(config), activeStrategy.id);
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

    res.json({ success: true, id, pnlPercent, pnlSol });
  } catch (err) {
    console.error('Close trade error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0, lastModified: false }));

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
