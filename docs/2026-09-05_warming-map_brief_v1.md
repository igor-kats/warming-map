# Warming Map — Claude Code brief v1 (new repo)

**Purpose (Igor, 2026-09-05):** a free, public, no-login, no-tracking web page that shows *where* the planet has warmed the most: an animated map that plays year by year, coloured blue (cooled) → grey (no change) → red (warmed most), where the user chooses the **baseline period** and the **rolling window** (1 / 5 / 10 years). Awareness, not a product. Nothing is sold, nothing is collected.

**Non-goals v1:** projections (CMIP), daily data, per-city pages, accounts, analytics, any backend at runtime.

## 1. Data

**v1 source — NASA GISTEMP v4 gridded anomalies**, file `gistemp1200_GHCNv4_ERSSTv5.nc` (2°×2° grid, monthly, 1880 → present, anomalies vs 1951–1980, 1200 km smoothing, public domain, ~200 MB NetCDF). Updated by NASA around the middle of each month.
- Reduce to **annual means per cell** (a year counts only if ≥ 9 months present, else missing).
- Store as `public/data/gistemp_annual.bin`: little-endian int16, value = anomaly × 100 (°C), missing = −32768; layout `[year][lat][lon]`; plus `gistemp_annual.json` with `{lats, lons, years, scale, missing, source, licence, built_at}`. Expected size ≈ 16,200 cells × ~146 years × 2 B ≈ 4.7 MB raw, ≈ 2 MB gzip/brotli (served compressed).
- Because the file already stores anomalies vs 1951–1980, a user-chosen baseline is just a re-centring: `value − mean(baseline years)` per cell. Do NOT convert to absolute temperatures.

**v2 source (later) — ERA5** `2m_temperature` monthly means from the Copernicus CDS (1940 → present, 0.25°, CC-BY 4.0, attribution required), coarsened to **1°** (64,800 cells × ~87 years ≈ 11 MB int16). Same binary layout. Not in v1.

**Build pipeline:** `scripts/build_gistemp.py` (Python 3.12, `xarray`, `netCDF4`, `numpy`): download → annual means → int16 → write `.bin` + `.json` → print a 5-line summary (years covered, % missing per decade, global mean trend as a sanity check ≈ +0.2 °C/decade since 1980). Deterministic; idempotent; no API keys needed for GISTEMP. Run monthly in **GitHub Actions** (cron on the 20th) → commits the two data files → Pages redeploys. The site never fetches NASA at runtime.

## 2. Frontend

- **Stack:** Vite + TypeScript, no UI framework (or Preact if a component model is needed), `d3-geo` for projection (Natural Earth or Equal Earth for world; equirectangular for the Europe / North America zooms), `d3-scale-chromatic` for the diverging palette, `topojson-client` + Natural Earth 110m land/coastlines (public domain) for outlines. Everything else hand-written. No map tiles, no Mapbox/Leaflet, no external requests at runtime except the two data files and the TopoJSON.
- **Rendering:** each frame is one `ImageData` of `lon × lat` pixels (180×90 for GISTEMP) painted onto a canvas through the projection (precompute the pixel→cell lookup once per viewport size; do not re-project every frame). Coastlines drawn once on an overlay canvas.
- **Computation (all client-side, on data load and on every control change):** per cell, prefix sums over years → baseline mean in O(1); rolling mean over the window in O(1) per year with the same prefix sums; anomaly = rolling mean − baseline mean. Cells with missing years inside the window or baseline follow a rule that is stated in the UI: missing if < 60% of the window years present. Whole recompute is ~2–3 M operations — must stay under 50 ms on a mid-range phone.
- **Controls:** baseline start / end (defaults 1951–1980; presets 1880–1910, 1951–1980, 1991–2020); window 1 / 5 / 10 years; play / pause; speed; year slider with the current year and window shown ("2016 — mean of 2012–2016 vs 1951–1980"); region: World / Europe / North America; palette: blue–grey–red (RdBu reversed, symmetric around 0, fixed ±2 °C by default with a ±1 / ±3 / ±4 toggle) and one colour-blind-safe alternative (PuOr). Legend always visible. Hover / tap on a cell → small panel with that cell's annual series (sparkline) and its change vs baseline.
- **URL state:** every control encoded in the hash (`#b=1951-1980&w=5&y=2016&r=eu&p=rdbu`) so a specific view can be shared; the page restores it on load.
- **Copy on the page (short, plain, no adjectives):** what the colours mean; what an anomaly is; that pre-1950 gaps are real gaps, not zeros; data source + licence line; "Built by Igor Kats · code on GitHub". No cookies banner because there are no cookies.

## 3. Hosting

Static only: **GitHub Pages** (or Cloudflare Pages) — free, CDN, HTTPS. There is no runtime backend to host, so a server is not needed. If Igor still prefers his own box: Hetzner CX22 + Caddy serving `dist/`, ~€4/month, deploy = `rsync` from the Actions job.

## 4. Repo layout

```
warming-map/
  README.md            what it is, how to run, data licences
  LICENSE              MIT (code); data licences in README and on the page
  scripts/build_gistemp.py
  .github/workflows/build-data.yml   monthly cron + manual dispatch
  .github/workflows/deploy.yml       build + Pages deploy on push to main
  public/data/gistemp_annual.{bin,json}
  public/geo/land-110m.json
  src/  (main.ts, data.ts, compute.ts, render.ts, controls.ts, url.ts)
  tests/ (compute.test.ts — prefix sums, rolling mean, missing rule; build_gistemp_test.py on a tiny synthetic NetCDF)
```

## 5. Acceptance

- First load ≤ 3 MB transferred; interactive within 2 s on 4G.
- Changing baseline or window recomputes and redraws in < 100 ms; playback smooth at 10 fps on a phone.
- The default view (world, 1951–1980 baseline, 5-year window, year 2024) visibly shows Arctic amplification and the "warming hole" south of Greenland — the standard sanity check of a correct anomaly map.
- Numbers reproducible: the global-mean anomaly the page computes for 2024 vs 1951–1980 matches NASA's published value within ±0.05 °C (state the comparison in the README).
- Works with keyboard; colours have a colour-blind alternative; no external scripts, fonts or trackers.

## 6. Order of work (one PR each)
1. `build_gistemp.py` + tests + Actions cron → data files in repo.
2. Static map with the default view, no controls.
3. Controls + client-side compute + URL state.
4. Hover panel, regions, palettes, copy, Pages deploy.
Then decide on ERA5 (v2) after looking at the result.

## 0. Local first
No hosting until there is something to show: `git init`, `python scripts/build_gistemp.py`, `npm run dev` → localhost. Pages/Cloudflare deploy is step 4, not step 1.

## 7. v3 — the second layer: who emits vs who warms (Igor, 2026-09-05)

**Intent:** show on the same map *where the emissions come from* and *where the warming is strongest*, so the viewer sees the two do not coincide — the emitters are one set of places, the places that warm most (Arctic, Siberia, Sahel, Middle East) are another. This is a statement, not a hypothesis test: CO₂ is globally well-mixed, so there is no local correlation to find and the page must not imply one. The only local signal is the opposite one — mid-century **aerosol cooling** over industrial Europe/US (the "warming hole"), which faded when the air was cleaned; mention it in the copy.

**Data:**
- **Gridded annual CO₂ (where the activity is):** EDGAR (JRC, European Commission) — 0.1° grid, annual, 1970 → present, by sector, free. Coarsen to the map grid (2° for GISTEMP, 1° for ERA5); store as the same int16 layout (unit: t CO₂ per cell per year, log-scaled for display). Alternative/cross-check: ODIAC (1°, monthly, 2000 →).
- **Cumulative by country (who is responsible):** Global Carbon Budget / Our World in Data — cumulative fossil CO₂ since 1850 per country, and per capita. Country polygons from Natural Earth 110m.

**UI:** a layer toggle *Warming · Emissions · Both*. "Both" = warming as fill colour + emissions as a second channel that stays readable (dot density or contour lines, not a second fill), with one legend each. A "Cumulative since 1850" mode colours countries instead of cells. Same year slider drives both layers (EDGAR from 1970; before that the emissions layer says "no gridded data before 1970", not blank).

**Copy (plain):** "Emissions anywhere warm everywhere. The places that emit most are not the places that warm most." One sentence on aerosols. Sources and licences per layer.

**Acceptance:** the "Both" view at year 2024 shows emission hotspots (East Asia, Europe, US East, Gulf) sitting in moderately warmed cells, while the deepest reds are in the Arctic and continental interiors with near-zero local emissions. Per-country cumulative view: top three by cumulative CO₂ are US, China, Russia (order per Global Carbon Budget) — state the source year.
