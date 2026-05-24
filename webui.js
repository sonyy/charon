import express from 'express';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

const dbPath = path.join(__dirname, 'charon.sqlite');
if (!fs.existsSync(dbPath)) {
  console.error(`Database not found at ${dbPath}`);
  process.exit(1);
}
const db = new Database(dbPath, { readonly: true });
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
db.pragma('cache_size = -8000');
db.pragma('temp_store = MEMORY');

const app = express();

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
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
             pnl_percent, pnl_sol, tp_percent, sl_percent, trailing_percent, strategy_id, execution_mode
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

app.get('/api/strategies', (req, res) => {
  try {
    const rows = db.prepare("SELECT DISTINCT strategy_id FROM dry_run_positions WHERE strategy_id IS NOT NULL ORDER BY strategy_id").all();
    res.json(rows.map(r => r.strategy_id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

const server = app.listen(PORT, () => {
  console.log(`Charon Trade Viewer running at http://localhost:${PORT}`);
});

// Graceful shutdown — WAL checkpoint + clean close = faster next startup
function shutdown() {
  console.log('\nShutting down...');
  try { db.close(); } catch(e) {}
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
