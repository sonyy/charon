# Terminal Theme — Pure Black & White Console

## TL;DR
> **Summary**: Replace all green (#00ff41) and red (#ff3355) in `public/index.html` with black/white/gray shades for a pure monochrome terminal console theme. All functionality preserved.
> **Deliverables**: 1 file updated (`public/index.html`)
> **Effort**: Quick
> **Parallel**: NO — single file, sequential edits
> **Critical Path**: CSS color replacement → JS class name replacement → JS chart color replacement → QA

## Context
### Original Request
> "ganti theme website nya jadi hitam putih saja dengan tema terminal console"

### Interview Summary
- User confirmed: keep mode tabs, keep Chart.js, keep detail stats section — just strip all green/red to B&W
- File: `public/index.html` (1030 lines), single inline CSS + JS
- Server running on port 3000 for QA

### Metis Review
Skipped (billing issue). Scope is narrow enough to proceed.

## Work Objectives
### Core Objective
Replace every occurrence of green (#00ff41) and red (#ff3355) in CSS and JS within `public/index.html` with monochrome (white/gray/black) equivalents. Profit values should appear bright (white), loss values dim (gray).

### Deliverables
- `public/index.html` — updated CSS and JS with pure B&W color scheme

### Definition of Done
- [ ] `grep -i "00ff41\|ff3355" public/index.html` returns zero matches
- [ ] `http://localhost:3000/` loads with no green or red pixels visible
- [ ] All values readable: profit = bright/bold white, loss = dim gray
- [ ] Summary cards, positions table, trades expand, chart, filters, pagination, detail stats all functional
- [ ] No JS console errors

### Must Have
- All green replaced with white/very-bright gray (#fff, #eee, #ddd)
- All red replaced with dim gray (#888, #777, #666)
- JS class references `'profit'` → `'val-up'`, `'loss'` → `'val-down'`
- JS class references `'g'` → `'val-up'`, `'r'` → `'val-down'`
- Chart segment colors: green → white/dim, red → dark gray
- `.tag-open` green border → gray border
- `.mode-tabs button.active` green → white

### Must NOT Have
- No HTML structure changes
- No JavaScript logic changes beyond color/class name strings
- No feature additions or removals
- No backend changes
- No breaking changes to existing functionality

## Verification Strategy
> ZERO HUMAN INTERVENTION — all verification is agent-executed.
- **Test decision**: No separate test framework needed. QA via browser + curl.
- **QA policy**: Every color replacement verified via grep. Full page QA via Playwright.

## Execution Strategy
### Parallel Execution Waves
Single wave — one file, sequential edits.

Wave 1: [1 task] All color replacements in `public/index.html`

### Dependency Matrix
- Task 1: None (single task)

### Agent Dispatch Summary
Wave 1 → 1 task → CSS/JS color replacement

## TODOs

- [~] 1. Strip all green/red colors from public/index.html to pure B&W (superseded — user opted for feature additions instead)

  **What to do**: Edit `public/index.html` to replace all green (#00ff41) and red (#ff3355) color values and their associated CSS class/JS string references. Use the exact edit map below.

  **Edit Map** (apply in this order):

  **CSS class renames:**
  1. `.value.profit, .profit` → `.value.val-up, .val-up`
  2. `.value.loss, .loss` → `.value.val-down, .val-down`
  3. `.row-profit` → `.row-up`
  4. `.g` → `.val-up` (in details-wrap CSS)
  5. `.r` → `.val-down` (in details-wrap CSS)

  **CSS color value replacements:**
  6. `.tag-open` block: `border: 1px solid #00ff41; color: #00ff41;` → `border: 1px solid #888; color: #ddd;`
  7. `.mode-tabs button.active { color: #00ff41;` → `.mode-tabs button.active { color: #fff;`
  8. `.page-nav button.active { color: #00ff41; border-color: #00ff41; }` → `.page-nav button.active { color: #fff; border-color: #888; }`
  9. `.profit` references in JS strings: `'profit'` → `'val-up'`, `'loss'` → `'val-down'`
  10. `.g` and `.r` JS string references in renderDetails: `'g'` → `'val-up'`, `'r'` → `'val-down'`

  **Chart color JS replacements (inside renderChart function):**
  11. `const colors = points.map(p => p.y >= 0 ? '#00ff41' : '#ff3355');` → `const colors = points.map(p => p.y >= 0 ? '#ddd' : '#555');`
  12. Chart segment: `borderColor: ctx => colors[ctx.p1DataIndex] || '#555'` — already uses `colors` array, no change needed
  13. Chart fill: `backgroundColor: 'rgba(255,255,255,0.02)'` — keep as-is (already B&W)

  **Other B&W improvements (optional but good):**
  14. `.row-up { background: rgba(255, 255, 255, 0.03); }` — keep subtle highlight
  15. `.row-loss` / `.row-down` — keep transparent (no background)

  **JS renderSummary replacement:**
  16. `c:d.totalPnlSol>=0?'profit':'loss'` → `c:d.totalPnlSol>=0?'val-up':'val-down'`

  **JS renderTable replacement:**
  17. `'profit'/'loss'` in PnL cell class strings → `'val-up'/'val-down'`

  **JS renderDetails replacement:**
  18. `.g` and `.r` in class strings → `.val-up` and `.val-down`
  19. `pnlCls(v) => v >= 0 ? 'g' : 'r'` → `pnlCls(v) => v >= 0 ? 'val-up' : 'val-down'`

  **JS renderChart tooltip:**
  20. Line 654: `ctx.parsed.y >= 0 ? '+'+ctx.parsed.y.toFixed(4)+' SOL' :` — keep as-is (not color dependent)

  **Critical check after all edits:** grep for `00ff41` and `ff3355` — must be zero.

  **Recommended Agent Profile**:
  - Category: `quick` — single file, find-and-replace edits
  - Skills: `[]` — no specialized skills needed

  **Parallelization**: NO | Wave 1 | Blocks: none | Blocked By: none

  **References**:
  - Current file: `public/index.html` (1030 lines) — read it fresh before editing
  - CSS profitability classes at lines 196-198: `.value.profit, .profit { color: #00ff41; }` and `.value.loss, .loss { color: #ff3355; }`
  - Chart color array at line 605: `const colors = points.map(p => p.y >= 0 ? '#00ff41' : '#ff3355');`
  - JS renderSummary at line 927: `c:d.totalPnlSol>=0?'profit':'loss'`
  - JS renderTable at lines 953, 965-966: `rc = p.pnl_sol>0?'row-profit'...` and `'profit'/'loss'` class refs
  - JS renderDetails lines 831-858: `.g` and `.r` class refs, `pnlCls` function
  - Tag styles at lines 399-407: `.tag-open` with green
  - Mode tabs active at line 101-103: `.mode-tabs button.active` with green
  - Page nav active at lines 270-274: `.page-nav button.active` with green

  **Acceptance Criteria**:
  - [ ] `Select-String -Pattern "00ff41|ff3355" -Path "public/index.html"` returns no matches
  - [ ] Server starts without error: `node webui.js` (stop existing first)
  - [ ] `curl http://localhost:3000/` returns HTTP 200

  **QA Scenarios**:
  ```
  Scenario: No green/red color values remain
    Tool: Bash
    Steps: Select-String -Pattern "00ff41|ff3355" -Path "public/index.html"
    Expected: No matches found
    Evidence: .omo/evidence/task-1-no-color-remnants.txt

  Scenario: Page loads and summary cards display
    Tool: Bash (via curl)
    Steps: 
      1. Stop existing server: npx http-kill 3000
      2. Start updated server: Start-Job -ScriptBlock { node webui.js }
      3. Start-Sleep 5
      4. Invoke-WebRequest -Uri http://localhost:3000/ | Select-Object StatusCode
    Expected: StatusCode = 200, response contains "Positions" text
    Evidence: .omo/evidence/task-1-page-load.txt

  Scenario: API endpoints return valid JSON
    Tool: Bash
    Steps: 
      $resp = Invoke-RestMethod http://localhost:3000/api/summary
      Write-Output $resp.totalPositions
      $pos = Invoke-RestMethod http://localhost:3000/api/positions
      Write-Output $pos.Count
    Expected: Summary has totalPositions > 0, positions have items
    Evidence: .omo/evidence/task-1-api-working.txt

  Scenario: Profit/loss visual differentiation
    Tool: Bash (curl + JS-less check)
    Steps: 
      $html = Invoke-WebRequest http://localhost:3000/ | Select-Object -ExpandProperty Content
      Contains val-up and val-down class references (not profit/loss)
    Expected: No 'class="profit"' or 'class="loss"' in HTML output
    Evidence: .omo/evidence/task-1-class-names.txt
  ```

  **Commit**: YES | Message: `style(webui): convert to pure B&W terminal theme` | Files: `public/index.html`

## Final Verification Wave
- [~] F1. Plan Compliance Audit — oracle (superseded — plan scope abandoned for feature additions)
- [~] F2. Code Quality Review — unspecified-high (superseded)
- [~] F3. Real Manual QA — unspecified-high (+ browser check) (superseded)
- [~] F4. Scope Fidelity Check — deep (superseded)

## Commit Strategy
Single commit: `style(webui): convert to pure B&W terminal theme`

## Success Criteria
- Zero green or red hex codes in `public/index.html`
- Page renders entirely in black/white/gray at `http://localhost:3000/`
- All features (summary, table, trades, chart, filters, pagination, detail stats, mode tabs, auto-refresh) work without errors
- Profit is clearly distinguishable from loss via brightness contrast (bright white vs dim gray)
