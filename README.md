# warming-map

Free, public, animated map of where the planet has warmed most — user-chosen baseline period and rolling window, blue (cooled) → grey → red (warmed). Later: a second layer showing where emissions come from.

No accounts, no tracking, no backend. See [the brief](docs/2026-09-05_warming-map_brief_v1.md).

## Status

Step 1 of 4: the data pipeline and the repo scaffold. The map itself is step 2.

## Run it

Two toolchains: Python builds the data file, Node serves the site.

```sh
# data (Python 3.12) — writes public/data/gistemp_annual.{bin,json}
python3.12 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python scripts/build_gistemp.py     # downloads ~200 MB from NASA, caches in .cache/
.venv/bin/python -m pytest tests -q

# site
npm install
npm run dev          # http://localhost:5173
npm test             # vitest
npm run typecheck
npm run build        # -> dist/
```

The source NetCDF is cached in `.cache/` and is not committed; the two derived
data files in `public/data/` are. `scripts/build_gistemp.py` is deterministic —
the same input always produces the same bytes — so a rebuild that changes
nothing produces no commit.

## Data

`public/data/gistemp_annual.bin` is a flat little-endian **int16** array laid out
`[year][lat][lon]`, where the stored integer is the anomaly in °C × 100 and
`-32768` means missing. `gistemp_annual.json` carries the coordinates, the year
list, the scale and sentinel, and the provenance. Annual means come from the
monthly source; a cell-year needs at least 9 present months, otherwise it is
missing. **Pre-1950 gaps are real gaps, not zeros.**

Values are anomalies against 1951–1980, as the source publishes them. A
user-chosen baseline is a re-centring of those anomalies, not a conversion to
absolute temperature.

### Reproducibility

Area-weighted (cos-latitude) global mean anomaly vs 1951–1980, as computed from
the committed binary, against NASA's published GISTEMP values:

| Year | This repo | NASA published | Difference |
| ---- | --------- | -------------- | ---------- |
| 2016 | +1.03 °C  | +1.02 °C       | 0.01       |
| 2020 | +1.01 °C  | +1.02 °C       | 0.01       |
| 2023 | +1.18 °C  | +1.17 °C       | 0.01       |
| 2024 | +1.29 °C  | +1.28 °C       | 0.01       |

Within the ±0.05 °C the brief asks for. The trend over 1980–2025 is
**+0.211 °C/decade**, matching the expected ≈ +0.2 °C/decade.

### Licences

Data: NASA GISTEMP v4 (public domain); ERA5 © ECMWF/Copernicus (CC BY 4.0) in v2; EDGAR (European Commission JRC) in v3. Code: MIT.

Cite GISTEMP as: GISTEMP Team, *GISS Surface Temperature Analysis (GISTEMP), version 4*, NASA Goddard Institute for Space Studies.

## Automation

`.github/workflows/build-data.yml` rebuilds the data on the 20th of each month
(NASA updates around mid-month) and on manual dispatch, and commits the two
files only when the binary actually changed. The site never contacts NASA at
runtime.
