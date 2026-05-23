# Web UI Trade & PnL Viewer

## TL;DR
> **Summary**: Build a standalone Express.js web UI that reads charon.sqlite and displays trade positions with total PnL summary, filterable by status and strategy, with expandable trade history per position.
> **Deliverables**: `webui.js` (Express server), `public/index.html` (single-page UI), `webui.bat` (launcher)
> **Effort**: Short (3 tasks)
> **Parallel**: NO (sequential)
> **Critical Path**: Install express → Create server + API → Create UI

## Context
### Original Request
"buatkan web ui untuk baca data trade di sqlite, lalu tampilkan data trade beserta ringkasan pnl total"

### Interview Summary
- Web server: Express.js (need npm install)
- Port: 3000
- Execution: Separate script (`node webui.js`), not bundled with bot
- Layout: Single page with PnL summary at top + positions table + expandable trade details per row
- Filters: By status (open/closed) and strategy
- Data access: Read-only via better-sqlite3 (already a dependency)
- Existing DB: charon.sqlite with dry_run_positions (42 rows, 27 closed) and dry_run_trades (69 rows)

### Metis Review
Metis unavailable (model routing issues). Manual gap analysis applied:
- **Read-only guard**: Web UI must NEVER write to DB — enforce with `db.readonly` pragma or separate read-only connection
- **Port conflict**: Port 3000 may conflict; document how to change via env or variable
- **DB locking**: better-sqlite3 handles WAL mode correctly; separate connection is safe
- **Large snapshot_json**: SELECT excludes snapshot_json unless explicitly requested to keep queries fast
- **Format consistency**: Reuse patterns from src/format.js (fmtSol, fmtPct, etc.) for consistent number display

## Work Objectives
### Core Objective
Build a web UI that reads trade data from charon.sqlite and displays positions with total PnL summary.

### Deliverables
1. `webui.js` — Express.js server with 3 JSON API endpoints + static file serving
2. `public/index.html` — Single-page HTML+CSS+JS UI
3. `webui.bat` — Windows batch launcher (optional convenience)
4. All data displayed without human intervention

### Definition of Done
- `node webui.js` starts server on port 3000
- Browser at `http://localhost:3000` shows PnL summary cards + positions table
- Status filter (All/Open/Closed) works
- Strategy filter (All/sniper/dip_buy/smart_money/degen) works
- Clicking a position row expands to show its trades (buy/sell)
- Total PnL SOL matches `SELECT SUM(pnl_sol) FROM dry_run_positions WHERE status='closed'`
- API endpoints return valid JSON
- No writes to the database occur

### Must Have
- Total PnL SOL + PnL % displayed prominently at top
- All positions listed with: symbol, strategy, status, size_sol, entry/exit price, pnl_sol, pnl_percent
- Green text for profit, red for loss
- Expand row to see individual trades for that position
- Filter by status (open/closed)
- Data refreshes on page load

### Must NOT Have
- No write/modify operations on the database
- No authentication system
- No real-time WebSocket updates
- No integration with bot's startCharon()
- No modification to existing src/ files
- No npm packages beyond express (and its deps)

## Verification Strategy
> ZERO HUMAN INTERVENTION — all verification is agent-executed.
- **Test decision**: Tests-after (manual verification via browser + curl)
- **QA policy**: Every task includes agent-executed verification scenarios
- **Evidence**: .omo/evidence/task-*.{txt,json}

## TODOs

- [x] 1. Install Express.js & Create Project Structure

  **What to do**:
  - Run `npm install express` in the project root
  - Create directory `public/` for static assets
  - Create `webui.bat` with: `@echo off && node "%~dp0webui.js"`

  **Must NOT do**:
  - Do NOT modify any existing files in src/
  - Do NOT modify index.js or package.json scripts

  **Recommended Agent Profile**:
  - Category: `quick` — simple npm install and directory creation
  - Skills: [] — no specialized skills needed
  - Omitted: N/A

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: [2,3] | Blocked By: none

  **References**:
  - Existing project: `C:\Users\thikfast\Documents\charon\package.json` — ESM project, better-sqlite3 already installed
  - DB connection pattern: `C:\Users\thikfast\Documents\charon\src\db\connection.js` — shows how to open charon.sqlite

  **Acceptance Criteria**:
  - [ ] `npm ls express` shows express in dependency tree
  - [ ] `public/` directory exists
  - [ ] `webui.bat` exists and contains valid batch script

  **QA Scenarios**:
  ```
  Scenario: Verify express installed
    Tool: Bash
    Steps: cd C:\Users\thikfast\Documents\charon && npm ls express
    Expected: Output includes "express@" with a version number
    Evidence: .omo/evidence/task-1-express-installed.txt

  Scenario: Verify directories exist
    Tool: Bash
    Steps: Test-Path "C:\Users\thikfast\Documents\charon\public" -PathType Container
    Expected: Returns True
    Evidence: .omo/evidence/task-1-directories.txt
  ```

  **Commit**: YES | Message: `feat(webui): add express dependency and public dir` | Files: [package.json, package-lock.json, public/, webui.bat]

---

- [x] 2. Create webui.js — Express Server with API Endpoints

  **What to do**:
  Create `webui.js` in project root with:
  1. Import express, better-sqlite3, path, fs, url
  2. Open read-only DB connection to charon.sqlite (use `import { db } from './src/db/connection.js'` or create separate connection with `Database('./charon.sqlite', { readonly: true })`)
  3. CORS headers (allow localhost)
  4. JSON parsing middleware
  5. Serve static files from `./public`
  6. Three API endpoints:
     - `GET /api/summary` — returns:
       ```json
       {
         "totalPositions": 42,
         "openPositions": 15,
         "closedPositions": 27,
         "totalPnlSol": -0.152,
         "totalPnlPercent": -5.2,
         "totalSizeSol": 2.1,
         "winCount": 8,
         "lossCount": 19,
         "winRate": 29.6,
         "bestTrade": { "symbol": "...", "pnlSol": 0.05 },
         "worstTrade": { "symbol": "...", "pnlSol": -0.03 }
       }
       ```
       Query logic:
       ```sql
       -- Closed positions stats
       SELECT COUNT(*) as closedCount,
              COALESCE(SUM(pnl_sol), 0) as totalPnlSol,
              COALESCE(AVG(pnl_percent), 0) as avgPnlPercent,
              COALESCE(SUM(size_sol), 0) as totalSizeSol,
              SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
              SUM(CASE WHEN pnl_sol < 0 THEN 1 ELSE 0 END) as losses
       FROM dry_run_positions WHERE status = 'closed'
       -- Open positions count
       SELECT COUNT(*) as openCount FROM dry_run_positions WHERE status = 'open'
       -- Total count
       SELECT COUNT(*) as totalCount FROM dry_run_positions
       -- Best/worst trades
       SELECT symbol, pnl_sol FROM dry_run_positions WHERE status = 'closed' ORDER BY pnl_sol DESC LIMIT 1
       SELECT symbol, pnl_sol FROM dry_run_positions WHERE status = 'closed' ORDER BY pnl_sol ASC LIMIT 1
       ```
     - `GET /api/positions?status=&strategy=` — returns filtered list of positions
       ```sql
       SELECT id, candidate_id, mint, symbol, status, opened_at_ms, closed_at_ms,
              size_sol, entry_price, entry_mcap, exit_price, exit_mcap, exit_reason,
              pnl_percent, pnl_sol, tp_percent, sl_percent, strategy_id, execution_mode
       FROM dry_run_positions
       WHERE (? = '' OR status = ?)
         AND (? = '' OR strategy_id = ?)
       ORDER BY opened_at_ms DESC
       LIMIT 200
       ```
       Return as JSON array. Format timestamps as ISO strings in the JS layer.
     - `GET /api/positions/:id/trades` — returns trades for a position
       ```sql
       SELECT id, side, at_ms, price, mcap, size_sol, reason, payload_json
       FROM dry_run_trades WHERE position_id = ?
       ORDER BY at_ms ASC
       ```
       Parse payload_json for pnlPercent/pnlSol on sell trades.

  7. Listen on port 3000 (or process.env.PORT || 3000)
  8. Console log when server starts

  All queries should use `db.prepare(...).all()` or `.get()`. No ORM.

  Use separate read-only DB connection (not the bot's connection) to avoid any risk of interference:
  ```js
  import Database from 'better-sqlite3';
  import { fileURLToPath } from 'url';
  import path from 'path';
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const db = new Database(path.join(__dirname, 'charon.sqlite'), { readonly: true });
  db.pragma('journal_mode = WAL');
  ```

  **Must NOT do**:
  - Do NOT modify any existing files
  - Do NOT add write queries
  - Do NOT import from src/app.js or src/db/connection.js (separate connection)

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — non-trivial Express API implementation
  - Skills: [] — standard Node.js/Express patterns
  - Omitted: N/A

  **Parallelization**: Can Parallel: NO | Wave 1 (after task 1) | Blocks: [3] | Blocked By: [1]

  **References**:
  - DB schema: `C:\Users\thikfast\Documents\charon\src\db\connection.js` lines 63-106 — dry_run_positions schema
  - DB schema: `C:\Users\thikfast\Documents\charon\src\db\connection.js` lines 94-106 — dry_run_trades schema
  - Sample position data (above in this plan)
  - Format patterns: `C:\Users\thikfast\Documents\charon\src\format.js` — fmtSol, fmtPct, fmtUsd, gmgnLink
  - Express static: https://expressjs.com/en/starter/static-files.html

  **Acceptance Criteria**:
  - [ ] `node webui.js` starts without error
  - [ ] `curl http://localhost:3000/api/summary` returns valid JSON with totalPnlSol
  - [ ] `curl http://localhost:3000/api/positions` returns JSON array
  - [ ] `curl http://localhost:3000/api/positions/1/trades` returns JSON array
  - [ ] `curl http://localhost:3000/api/positions?status=closed` returns only closed positions
  - [ ] No database write operations occur (verify with `db.readonly` or check that no INSERT/UPDATE/DELETE queries exist in file)

  **QA Scenarios**:
  ```
  Scenario: Server starts and summary API works
    Tool: Bash
    Steps: Start server in background, wait 2s, then curl http://localhost:3000/api/summary, then kill server
    Expected: Returns JSON with "totalPnlSol" field
    Evidence: .omo/evidence/task-2-summary-api.txt

  Scenario: Positions API returns data
    Tool: Bash
    Steps: Start server, curl http://localhost:3000/api/positions, kill server
    Expected: Returns JSON array with position objects containing id, symbol, status
    Evidence: .omo/evidence/task-2-positions-api.txt

  Scenario: Filter by status works
    Tool: Bash
    Steps: curl http://localhost:3000/api/positions?status=closed
    Expected: All items have status "closed"
    Evidence: .omo/evidence/task-2-filter-status.txt
  ```

  **Commit**: YES | Message: `feat(webui): create express server with trade/pnl API endpoints` | Files: [webui.js]

---

- [x] 3. Create public/index.html — Single-Page UI

  **What to do**:
  Create `public/index.html` as a single-file HTML application with embedded CSS and JS. No frameworks, no build step.

  **Layout (top to bottom)**:

  1. **Header**: "Charon Trade Viewer" title, refresh button, last-updated timestamp

  2. **Summary Cards** (4 cards in a row):
     - Total PnL (SOL) — large number, green if positive, red if negative
     - Win Rate (%) — with win/loss count below
     - Total Positions (open/closed)
     - Total Volume (size_sol total)
     Each card: label on top, big number center, small sub-text below

  3. **Filter Bar**:
     - Status dropdown: All | Open | Closed
     - Strategy dropdown: All | sniper | dip_buy | smart_money | degen
     - (Populate strategies dynamically from API data)

  4. **Positions Table**:
     Columns: # | Symbol (with GMGN link) | Strategy | Status | Size (SOL) | Entry Price | Exit Price | PnL (SOL) | PnL (%) | Exit Reason | Duration | Actions
     - Sortable columns (click header to sort)
     - Color coding: green row tint for profit, red for loss
     - Click on a row to expand/collapse trade details below it
     - Show skeleton/loading state while fetching

  5. **Expanded Trade Detail** (shown when row clicked):
     Small sub-table with columns: # | Side (buy/sell) | Time | Price | MCAP | Size (SOL) | Reason
     - Buy rows in green tint, Sell rows in red/orange tint

  6. **Footer**: "Data from charon.sqlite | Last refreshed: ..."

  **CSS Requirements**:
  - Dark theme (background: #1a1a2e, cards: #16213e, table rows: #0f3460 alternating)
  - Responsive layout (works on desktop, usable on tablet)
  - Profit color: #00c853 (green), Loss color: #ff1744 (red)
  - Clean typography (system font stack)
  - Smooth expand/collapse animation
  - Table header sticky on scroll
  - Hover effect on table rows

  **JS Requirements**:
  - `fetchData()` — fetches /api/summary + /api/positions and renders
  - `renderSummary(data)` — populates summary cards
  - `renderPositions(positions)` — populates table body
  - `renderTrades(trades, rowEl)` — renders expandable trade rows
  - Filter change triggers re-fetch with query params
  - Sort by column (click header, toggle asc/desc)
  - Auto-refresh on page load, manual refresh via button
  - Handle empty states, loading states, error states
  - Format numbers using same conventions as src/format.js:
    - SOL amounts: 4 decimal places
    - Prices: scientific notation if < 0.0001, else 6-8 decimals
    - PnL %: 1 decimal place + "%" suffix
    - PnL SOL: 4-6 decimal places
    - Timestamps: convert from ms to readable date/time
    - MCAP: fmtUsd-style ($1.2K, $45.3K, $1.2M)

  **Must NOT do**:
  - Do NOT include any external CDN scripts (no React, no jQuery, no Chart.js)
  - Do NOT modify any files outside public/
  - Do NOT add build steps, bundlers, or transpilers
  - Do NOT use CSS frameworks (no Bootstrap, Tailwind)

  **Recommended Agent Profile**:
  - Category: `visual-engineering` — UI/UX focused task
  - Skills: [] — standard HTML/CSS/JS
  - Omitted: N/A

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: none | Blocked By: [1, 2]

  **References**:
  - API shapes defined in Task 2 (summary, positions, trades endpoints)
  - Format helpers: `C:\Users\thikfast\Documents\charon\src\format.js` — fmtSol, fmtPct, fmtUsd, gmgnLink
  - Sample data from task 2 QA outputs

  **Acceptance Criteria**:
  - [ ] Opening http://localhost:3000 shows rendered page with summary cards
  - [ ] Total PnL SOL card shows the correct value (matches SQL query)
  - [ ] Positions table has data rows
  - [ ] Status filter dropdown works (shows/hides positions)
  - [ ] Strategy filter dropdown works
  - [ ] Clicking a position row expands to show trades sub-table
  - [ ] Profit rows are green-tinted, loss rows are red-tinted
  - [ ] Expand/collapse works smoothly (click again to collapse)

  **QA Scenarios**:
  ```
  Scenario: Page loads and shows summary
    Tool: Bash
    Steps: Start server, curl http://localhost:3000 | findstr "totalPnl"
    Expected: HTML response contains summary cards with PnL data
    Evidence: .omo/evidence/task-3-page-load.txt

  Scenario: All API endpoints render correctly via browser fetch
    Tool: Bash
    Steps: Start server, use curl on each endpoint and verify JSON structure
    Expected: Valid JSON responses for /api/summary, /api/positions, /api/positions/:id/trades
    Evidence: .omo/evidence/task-3-api-verify.txt
  ```

  **Commit**: YES | Message: `feat(webui): create single-page trade viewer UI` | Files: [public/index.html]

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.

- [~] F1. **Plan Compliance Audit** — oracle
  Verify: All 3 tasks completed per spec. No missing files. API endpoints match spec. DB is read-only. No src/ files modified.

- [~] F2. **Code Quality Review** — unspecified-high
  Verify: webui.js handles errors gracefully (DB errors → 500 with message). HTML has no JS errors. CSS is responsive. No hardcoded credentials.

- [~] F3. **Real Manual QA** — unspecified-high
  Verify: Start server, open browser, confirm summary cards match SQL query results. Test filters. Expand rows. Test edge cases (empty results, invalid position ID).

- [~] F4. **Scope Fidelity Check** — deep
  Verify: No write operations. No auth system added. No external CDNs. No modifications to src/ or index.js. Single page, no build step.

## Commit Strategy

| # | Message | Files |
|---|---------|-------|
| 1 | `feat(webui): add express dependency and public dir` | package.json, package-lock.json, public/, webui.bat |
| 2 | `feat(webui): create express server with trade/pnl API endpoints` | webui.js |
| 3 | `feat(webui): create single-page trade viewer UI` | public/index.html |

All commits separate. No squashing — each task is independently reviewable.

## Success Criteria

1. ✅ Server starts on port 3000 with `node webui.js`
2. ✅ Browser shows PnL summary (total SOL, win rate, position counts) in cards
3. ✅ All 42 positions displayed in table with correct color coding
4. ✅ Status + strategy filters work correctly
5. ✅ Click position row → trade history expands below
6. ✅ All data read from charon.sqlite — no bot interference
7. ✅ No modifications to existing bot code
8. ✅ `npm ls express` shows installed version
9. ✅ Total PnL displayed matches direct SQL query result

## Notes for Executor

- The `charon.sqlite` path is relative to project root. webui.js uses `path.join(__dirname, 'charon.sqlite')`.
- Use `db.pragma('journal_mode = WAL')` after connecting to avoid locking issues.
- For the WAL files (charon.sqlite-shm, charon.sqlite-wal), they're automatically managed by SQLite — read-only connection works fine.
- If port 3000 is busy, set PORT env var: `$env:PORT=3001; node webui.js`
- All timestamps in DB are epoch ms. Convert to ISO strings for the JSON API, then format to locale strings in the UI.
- The `payload_json` field in trades sometimes has nested pnl data. Parse it on the server side and include as `pnlPercent`/`pnlSol` in the response.
