# Draft: Terminal Theme — Pure B&W Console

## Request (verbatim)
> "ganti theme website nya jadi hitam putih saja dengan tema terminal console"

## Clarified Scope (from user answers)
- **Mode tabs**: leave as-is (not in scope)
- **Chart.js**: leave as-is (not in scope)
- **Detail stats**: keep in B&W (strip colors)
- **Core scope**: replace ALL CSS colors (#00ff41 green, #ff3355 red, etc.) with black/white/gray shades only. JS color references too.

## Current State (public/index.html, 1030 lines)
- Contains `#00ff41` (green) for: profit values, tag-open borders, mode tab active, chart segments, row-profit background, ".g" class, ".profit" class
- Contains `#ff3355` (red) for: loss values, chart segments, ".r" class, ".loss" class
- JS `renderChart()` uses `colors` array based on pnl sign
- JS `renderSummary()` uses `'profit'/'loss'` CSS classes
- JS `renderTable()` uses `'profit'/'loss'` classes for PnL cells
- JS `renderDetails()` uses `'g'/'r'` CSS classes

## Changes Required
1. CSS: replace all color values — use only `#000, #111, #222, #333, #444, #555, #666, #888, #999, #aaa, #bbb, #ccc, #ddd, #eee, #fff`
2. CSS: `.profit` → `.val-up` (color: #fff), `.loss` → `.val-down` (color: #888), `.g` → `.val-up`, `.r` → `.val-down`
3. CSS: `.tag-open` border green → border #888
4. CSS: `.mode-tabs button.active` green → white
5. CSS: remove `.row-profit` background (or make rgba(255,255,255,0.03))
6. JS `renderSummary()`: class `'profit'/'loss'` → `'val-up'/'val-down'`
7. JS `renderTable()`: PnL cell class `'profit'/'loss'` → `'val-up'/'val-down'`
8. JS `renderDetails()`: class `'g'/'r'` → `'val-up'/'val-down'`
9. JS `renderChart()`: `colors` array `'#00ff41'/'#ff3355'` → `'#fff'/'#888'`, tooltip prefix keep same
10. JS `renderChart()`: segment colors `'#00ff41'/'#ff3355'` → `'#ddd'/'#555'` or single white

## Out of Scope
- No backend changes
- No HTML structure changes
- No feature removal
- No new features
