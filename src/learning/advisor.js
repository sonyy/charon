import { db } from '../db/connection.js';
import { now, safeJson } from '../utils.js';
import { numSetting, boolSetting, activeStrategy } from '../db/settings.js';
import { sendTelegram } from '../telegram/send.js';
import { escapeHtml, fmtPct, fmtSol, fmtUsd } from '../format.js';

const ANALYSIS_WINDOW_MS = 24 * 60 * 60 * 1000;

export function startAdvisor() {
  // Advisor is now triggered manually via Telegram button (/advisor)
  console.log('[advisor] manual trigger only');
}

export function stopAdvisor() {
}

export async function runAdvisor(chatId = null) {
  const cutoff = now() - ANALYSIS_WINDOW_MS;
  const suggestions = [];

  const filterData = analyzeFilterFailures(cutoff);
  if (filterData.totalFiltered > 0) {
    suggestions.push(...generateFilterSuggestions(filterData));
  }

  const tradeData = analyzeTradePerformance(cutoff);
  if (tradeData.closed > 0) {
    suggestions.push(...generateTradeSuggestions(tradeData));
  }

  if (tradeData.byRoute && tradeData.byRoute.length > 1) {
    suggestions.push(...generateRouteSuggestions(tradeData.byRoute));
  }
  if (suggestions.length > 0) {
    await sendAdvisorReport(suggestions, filterData, tradeData, chatId);
  } else {
    console.log('[advisor] not enough data yet, skipping');
  }
}

function analyzeFilterFailures(cutoff) {
  const rows = db.prepare(`
    SELECT filter_result_json, status, created_at_ms
    FROM candidates
    WHERE created_at_ms >= ?
  `).all(cutoff);

  const byStrategy = {};
  const byFailureKey = {};
  let totalFiltered = 0;
  let totalCandidates = rows.length;

  for (const row of rows) {
    const fr = safeJson(row.filter_result_json, {});
    const strat = row.strategy_id || fr.strategy || 'unknown';

    if (!byStrategy[strat]) byStrategy[strat] = { filtered: 0, total: 0, failures: {} };
    byStrategy[strat].total++;

    if (row.status === 'filtered') {
      totalFiltered++;
      byStrategy[strat].filtered++;
      for (const fail of (fr.failures || [])) {
        const key = fail.split(':')[0].trim();
        byStrategy[strat].failures[key] = (byStrategy[strat].failures[key] || 0) + 1;
        byFailureKey[key] = (byFailureKey[key] || 0) + 1;
      }
    }
  }

  return { totalCandidates, totalFiltered, byStrategy, byFailureKey };
}

function analyzeTradePerformance(cutoff) {
  const positions = db.prepare(`
    SELECT * FROM dry_run_positions
    WHERE opened_at_ms >= ?
    ORDER BY opened_at_ms ASC
  `).all(cutoff);

  const closed = positions.filter(p => p.status === 'closed' && p.pnl_sol != null);
  const open = positions.filter(p => p.status === 'open');
  const winners = closed.filter(p => Number(p.pnl_percent || 0) > 0);
  const losers = closed.filter(p => Number(p.pnl_percent || 0) <= 0);

  const totalPnlSol = closed.reduce((s, p) => s + Number(p.pnl_sol || 0), 0);
  const totalPnlPct = closed.reduce((s, p) => s + Number(p.pnl_percent || 0), 0);

  const byStrategy = {};
  for (const p of closed) {
    const s = p.strategy_id || 'unknown';
    if (!byStrategy[s]) byStrategy[s] = { count: 0, wins: 0, losses: 0, pnlSol: 0, pnlPctSum: 0 };
    byStrategy[s].count++;
    if (Number(p.pnl_percent || 0) > 0) byStrategy[s].wins++;
    else byStrategy[s].losses++;
    byStrategy[s].pnlSol += Number(p.pnl_sol || 0);
    byStrategy[s].pnlPctSum += Number(p.pnl_percent || 0);
  }

  const exitReasons = {};
  for (const p of closed) {
    const r = p.exit_reason || 'unknown';
    if (!exitReasons[r]) exitReasons[r] = { count: 0, pnlSol: 0 };
    exitReasons[r].count++;
    exitReasons[r].pnlSol += Number(p.pnl_sol || 0);
  }

  const byRoute = {};
  for (const p of closed) {
    const snap = safeJson(p.snapshot_json, {});
    const candidate = snap.candidate || {};
    const route = candidate.signals?.route || candidate.signals?.label || 'unknown';
    if (!byRoute[route]) byRoute[route] = { count: 0, wins: 0, losses: 0, pnlSol: 0, pnlPctSum: 0 };
    byRoute[route].count++;
    if (Number(p.pnl_percent || 0) > 0) byRoute[route].wins++;
    else byRoute[route].losses++;
    byRoute[route].pnlSol += Number(p.pnl_sol || 0);
    byRoute[route].pnlPctSum += Number(p.pnl_percent || 0);
  }


  const winnerMcaps = winners.map(p => Number(p.entry_mcap || 0)).filter(v => v > 0);
  const loserMcaps = losers.map(p => Number(p.entry_mcap || 0)).filter(v => v > 0);
  const avgWinnerMcap = winnerMcaps.length ? winnerMcaps.reduce((s, v) => s + v, 0) / winnerMcaps.length : 0;
  const avgLoserMcap = loserMcaps.length ? loserMcaps.reduce((s, v) => s + v, 0) / loserMcaps.length : 0;
  const minWinnerMcap = winnerMcaps.length ? Math.min(...winnerMcaps) : 0;
  const maxLoserMcap = loserMcaps.length ? Math.max(...loserMcaps) : 0;

  return {
    total: positions.length,
    open: open.length,
    closed: closed.length,
    wins: winners.length,
    losses: losers.length,
    winRate: closed.length ? (winners.length / closed.length * 100) : 0,
    totalPnlSol,
    avgPnlPct: closed.length ? totalPnlPct / closed.length : 0,
    byStrategy: Object.entries(byStrategy).map(([id, d]) => ({
      id,
      count: d.count,
      winRate: d.count ? (d.wins / d.count * 100) : 0,
      avgPnlPct: d.count ? d.pnlPctSum / d.count : 0,
      pnlSol: d.pnlSol,
    })).sort((a, b) => b.pnlSol - a.pnlSol),
    exitReasons,
    byRoute: Object.entries(byRoute).map(([route, d]) => ({
      route,
      count: d.count,
      winRate: d.count ? (d.wins / d.count * 100) : 0,
      avgPnlPct: d.count ? d.pnlPctSum / d.count : 0,
      pnlSol: d.pnlSol,
    })).sort((a, b) => b.pnlSol - a.pnlSol),
    avgWinnerMcap,
    avgLoserMcap,
    minWinnerMcap,
    maxLoserMcap,
  };
}

function generateFilterSuggestions(data) {
  const suggestions = [];
  const threshold = 0.15;

  for (const [strat, sd] of Object.entries(data.byStrategy)) {
    if (sd.filtered < 10) continue;
    const filterRate = sd.filtered / sd.total;
    if (filterRate < 0.1) continue;

    const stratSuggestions = [];
    for (const [key, count] of Object.entries(sd.failures)) {
      const ratio = count / sd.filtered;
      if (ratio >= threshold) {
        stratSuggestions.push({ key, count, ratio, severity: ratio >= 0.5 ? 'high' : ratio >= 0.3 ? 'medium' : 'low' });
      }
    }

    if (stratSuggestions.length > 0) {
      stratSuggestions.sort((a, b) => b.ratio - a.ratio);
      const top = stratSuggestions.slice(0, 3);
      const lines = top.map(s =>
        `• <b>${escapeHtml(s.key)}</b>: ${s.count}x (${fmtPct(s.ratio * 100)} of filtered)`
      ).join('\n');
      suggestions.push({
        type: 'filter',
        priority: filterRate > 0.5 ? 'high' : 'medium',
        lines: [
          `📊 <b>${escapeHtml(strat)}</b>: ${sd.filtered}/${sd.total} filtered (${fmtPct(filterRate * 100)})`,
          lines,
        ],
      });
    }
  }
  return suggestions;
}

function generateTradeSuggestions(data) {
  const suggestions = [];

  if (data.closed >= 5) {
    if (data.winRate < 40) {
      suggestions.push({
        type: 'trade',
        priority: 'high',
        lines: [
          `⚠️ Win rate hanya <b>${fmtPct(data.winRate)}</b> dari ${data.closed} closed trades (${fmtSol(data.totalPnlSol)} SOL).`,
          `Pertimbangkan memperketat filter atau ganti strategy.`,
        ],
      });
    } else if (data.winRate > 70) {
      suggestions.push({
        type: 'trade',
        priority: 'low',
        lines: [
          `✅ Win rate <b>${fmtPct(data.winRate)}</b> — bagus! Mungkin bisa略微 longgarin filter untuk lebih banyak peluang.`,
        ],
      });
    }
  }

  for (const s of data.byStrategy) {
    if (s.count < 3) continue;
    if (s.pnlSol < 0) {
      suggestions.push({
        type: 'strategy',
        priority: s.pnlSol < -0.5 ? 'high' : 'medium',
        lines: [
          `📉 <b>${escapeHtml(s.id)}</b>: ${fmtSol(s.pnlSol)} SOL (${s.wins}W/${s.losses}L) · avg ${fmtPct(s.avgPnlPct)}`,
          `Pertimbangkan pause strategy ini atau tightening filter.`,
        ],
      });
    } else if (s.pnlSol > 0.5) {
      suggestions.push({
        type: 'strategy',
        priority: 'low',
        lines: [
          `📈 <b>${escapeHtml(s.id)}</b>: +${fmtSol(s.pnlSol)} SOL (${fmtPct(s.winRate)} WR dari ${s.count} trades)`,
          `Strategy ini performa baik — pertahankan setting saat ini.`,
        ],
      });
    }
  }

  if (data.avgWinnerMcap > 0 && data.avgLoserMcap > 0) {
    const ratio = data.avgWinnerMcap / data.avgLoserMcap;
    if (ratio > 1.5) {
      suggestions.push({
        type: 'mcap',
        priority: 'medium',
        lines: [
          `💰 Winner avg entry mcap: <b>${fmtUsd(data.avgWinnerMcap)}</b> vs Loser: <b>${fmtUsd(data.avgLoserMcap)}</b>`,
          `Winners cenderung di mcap lebih tinggi (${ratio.toFixed(1)}x). Coba naikkan min_mcap_usd.`,
        ],
      });
    } else if (ratio < 0.67) {
      suggestions.push({
        type: 'mcap',
        priority: 'medium',
        lines: [
          `💰 Winner avg entry mcap: <b>${fmtUsd(data.avgWinnerMcap)}</b> vs Loser: <b>${fmtUsd(data.avgLoserMcap)}</b>`,
          `Winners cenderung di mcap lebih rendah. Coba turunkan max_mcap_usd.`,
        ],
      });
    }
  }

  const exitEntries = Object.entries(data.exitReasons).sort((a, b) => b[1].count - a[1].count);
  if (exitEntries.length > 0) {
    const topExit = exitEntries[0];
    const slEntry = exitEntries.find(e => e[0] === 'SL');
    if (slEntry && slEntry[1].count >= 3 && slEntry[1].count / data.closed > 0.3) {
      suggestions.push({
        type: 'exit',
        priority: 'high',
        lines: [
          `🛑 SL exit dominan: <b>${slEntry[1].count}x</b> (${fmtPct(slEntry[1].count / data.closed * 100)} dari closed)`,
          `Coba longgarkan SL atau entry di mcap yg lebih rendah untuk reduce SL hits.`,
        ],
      });
    }
  }

  return suggestions;
}

function generateRouteSuggestions(routes) {
  const suggestions = [];
  const best = routes[0];
  const worst = [...routes].sort((a, b) => a.pnlSol - b.pnlSol)[0];

  if (best && best.count >= 2 && best.pnlSol > 0.2) {
    suggestions.push({
      type: 'route',
      priority: 'low',
      lines: [
        `🏆 Best signal route: <b>${escapeHtml(best.route)}</b> — ${fmtSol(best.pnlSol)} SOL (${fmtPct(best.winRate)} WR, ${best.count} trades)`,
      ],
    });
  }
  if (worst && worst.count >= 2 && worst.pnlSol < -0.2 && worst.route !== best?.route) {
    suggestions.push({
      type: 'route',
      priority: 'medium',
      lines: [
        `⚠️ Worst signal route: <b>${escapeHtml(worst.route)}</b> — ${fmtSol(worst.pnlSol)} SOL (${fmtPct(worst.winRate)} WR, ${worst.count} trades)`,
        `Pertimbangkan stricter filter untuk ${escapeHtml(worst.route)} signal.`,
      ],
    });
  }
  return suggestions;
}

async function sendAdvisorReport(suggestions, filterData, tradeData, chatId = null) {
  const strat = activeStrategy();
  const blocks = [];
  const nowDate = new Date().toLocaleString();

  blocks.push(`🧠 <b>Charon Advisor</b> · ${nowDate}`);
  blocks.push(`Window: <b>24h</b> · Strategy: <b>${escapeHtml(strat.name)}</b>`);

  if (tradeData.closed > 0) {
    blocks.push('');
    blocks.push(`📊 <b>Performance</b>`);
    const pnlSign = tradeData.totalPnlSol >= 0 ? '+' : '';
    blocks.push(`Closed: ${tradeData.closed} · WR: <b>${fmtPct(tradeData.winRate)}</b> · PnL: <b>${pnlSign}${fmtSol(tradeData.totalPnlSol)}</b> SOL`);
    blocks.push(`Avg: <b>${fmtPct(tradeData.avgPnlPct)}</b> · Open: ${tradeData.open}/${tradeData.total}`);
  }

  if (filterData.totalFiltered > 0) {
    blocks.push('');
    blocks.push(`🔍 <b>Filter Activity</b>`);
    blocks.push(`Candidates: ${filterData.totalCandidates} · Filtered: <b>${filterData.totalFiltered}</b> (${fmtPct(filterData.totalFiltered / filterData.totalCandidates * 100)})`);
  }

  suggestions.sort((a, b) => {
    const p = { high: 0, medium: 1, low: 2 };
    return (p[a.priority] || 1) - (p[b.priority] || 1);
  });

  blocks.push('');
  blocks.push(`💡 <b>Suggestions (${suggestions.length})</b>`);
  for (const s of suggestions.slice(0, 5)) {
    blocks.push('');
    blocks.push(s.lines.join('\n'));
  }

  blocks.push('');
  blocks.push(`⚙️ /strategy untuk settings · /learn untuk analisa lanjutan`);

  try {
    await sendTelegram(blocks.join('\n'), {}, chatId);
  } catch (err) {
    console.log(`[advisor] send failed: ${err.message}`);
  }
}
