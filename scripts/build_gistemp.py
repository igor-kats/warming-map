#!/usr/bin/env python3
"""Build public/data/gistemp_annual.{bin,json} from NASA GISTEMP v4 gridded anomalies.

Source: gistemp1200_GHCNv4_ERSSTv5.nc  (2x2 degree, monthly, 1880-present,
anomalies vs 1951-1980, 1200 km smoothing, public domain).

Reduce monthly anomalies to annual means per cell (a year counts for a cell only
if at least MIN_MONTHS of its months are present, else the cell-year is missing),
quantise to int16 (anomaly * 100, missing = -32768) and write a flat
[year][lat][lon] little-endian array plus a JSON sidecar.

Deterministic and idempotent: the same input file always yields the same bytes
(the JSON carries a build date, not a timestamp).
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import shutil
import sys
import urllib.request
import warnings
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

SOURCE_URL = "https://data.giss.nasa.gov/pub/gistemp/gistemp1200_GHCNv4_ERSSTv5.nc.gz"
SOURCE_NAME = "NASA GISTEMP v4 (gistemp1200_GHCNv4_ERSSTv5)"
SOURCE_LICENCE = "Public domain (NASA GISS). Cite: GISTEMP Team, GISS Surface Temperature Analysis (GISTEMP), version 4."
BASELINE = "1951-1980"

SCALE = 100  # stored value = anomaly degC * SCALE
MISSING = -32768  # int16 sentinel
INT16_MIN, INT16_MAX = -32767, 32767  # MISSING is reserved
MIN_MONTHS = 9  # a cell-year needs at least this many months present
MONTHS_PER_YEAR = 12  # the final year is kept only if the source covers all of them

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT_DIR = REPO_ROOT / "public" / "data"
DEFAULT_CACHE_DIR = REPO_ROOT / ".cache"


# --------------------------------------------------------------------------
# pure computation
# --------------------------------------------------------------------------


def annual_means(
    monthly: np.ndarray, month_years: np.ndarray, min_months: int = MIN_MONTHS
) -> tuple[np.ndarray, np.ndarray]:
    """Collapse (time, lat, lon) monthly anomalies to (year, lat, lon) annual means.

    `monthly` uses NaN for missing. A cell-year with fewer than `min_months`
    present months comes back as NaN. Years are returned sorted ascending.
    """
    if monthly.ndim != 3:
        raise ValueError(f"expected (time, lat, lon), got shape {monthly.shape}")
    if monthly.shape[0] != month_years.shape[0]:
        raise ValueError("monthly and month_years disagree on the time axis")

    years = np.unique(month_years)
    out = np.full((years.size, monthly.shape[1], monthly.shape[2]), np.nan, dtype=np.float64)

    for i, year in enumerate(years):
        block = monthly[month_years == year]
        present = np.count_nonzero(~np.isnan(block), axis=0)
        # A cell with no present month makes nanmean warn about an empty slice;
        # the `present >= min_months` mask discards that cell anyway.
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            mean = np.nanmean(block, axis=0)
        out[i] = np.where(present >= min_months, mean, np.nan)

    return years, out


def drop_incomplete_final_years(
    years: np.ndarray,
    annual: np.ndarray,
    month_years: np.ndarray,
    month_numbers: np.ndarray,
    months_required: int = MONTHS_PER_YEAR,
) -> tuple[np.ndarray, np.ndarray, int]:
    """Drop trailing years that the source does not cover for all twelve months.

    This overrides MIN_MONTHS at the end of the record. A part-finished current
    year averages only the months that have happened, so its "annual" mean is
    seasonally biased -- warm if the file ends in summer, cold if in winter --
    and must never be published as an annual value, however many cells cleared
    the nine-month bar.

    Interior years are untouched: only the tail is trimmed, and trimming stops
    at the first year the source covers completely.
    """
    keep = years.size
    while keep > 0:
        year = years[keep - 1]
        covered = np.unique(month_numbers[month_years == year]).size
        if covered >= months_required:
            break
        keep -= 1
    return years[:keep], annual[:keep], years.size - keep


def quantise(annual: np.ndarray, scale: int = SCALE, missing: int = MISSING) -> np.ndarray:
    """Quantise annual means to int16: round(value * scale), NaN -> missing."""
    valid = np.isfinite(annual)
    scaled = np.rint(np.where(valid, annual, 0.0) * scale)
    if np.any(np.abs(scaled[valid]) > INT16_MAX):
        raise ValueError("anomaly out of int16 range after scaling; check the source units")
    scaled = np.clip(scaled, INT16_MIN, INT16_MAX)
    return np.where(valid, scaled, missing).astype("<i2")


def area_weights(lats: np.ndarray) -> np.ndarray:
    """cos(latitude) cell weights, one per latitude band."""
    return np.cos(np.deg2rad(np.asarray(lats, dtype=np.float64)))


def global_means(annual: np.ndarray, lats: np.ndarray) -> np.ndarray:
    """Area-weighted global mean anomaly per year over the valid cells (NaN if none)."""
    weights = area_weights(lats)[None, :, None] * np.ones_like(annual)
    valid = np.isfinite(annual)
    weights = np.where(valid, weights, 0.0)
    total = weights.sum(axis=(1, 2))
    numerator = np.where(valid, annual, 0.0) * weights
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(total > 0, numerator.sum(axis=(1, 2)) / total, np.nan)


def trend_per_decade(years: np.ndarray, series: np.ndarray, since: int) -> tuple[float, int, int]:
    """Least-squares slope of `series` vs year, in units per decade, from `since` on."""
    mask = np.isfinite(series) & (years >= since)
    if np.count_nonzero(mask) < 2:
        return float("nan"), 0, 0
    x = years[mask].astype(np.float64)
    y = series[mask].astype(np.float64)
    slope = np.polyfit(x, y, 1)[0]
    return float(slope * 10.0), int(x[0]), int(x[-1])


def missing_by_decade(years: np.ndarray, annual: np.ndarray) -> list[tuple[int, float]]:
    """Percent of cell-years missing, per decade."""
    out: list[tuple[int, float]] = []
    decades = np.unique((years // 10) * 10)
    for decade in decades:
        block = annual[(years // 10) * 10 == decade]
        out.append((int(decade), 100.0 * float(np.count_nonzero(~np.isfinite(block))) / block.size))
    return out


# --------------------------------------------------------------------------
# io
# --------------------------------------------------------------------------


@dataclass
class Grid:
    lats: np.ndarray
    lons: np.ndarray
    years: np.ndarray
    annual: np.ndarray  # (year, lat, lon) float, NaN = missing


def download(url: str, cache_dir: Path) -> Path:
    """Fetch the gzipped NetCDF into the cache and return the decompressed path."""
    name = Path(url).name
    if not name.endswith(".gz"):
        raise ValueError(f"expected a gzipped NetCDF url, got {url}; use --input for a local file")

    cache_dir.mkdir(parents=True, exist_ok=True)
    gz_path = cache_dir / name
    nc_path = cache_dir / name.removesuffix(".gz")

    if not gz_path.exists():
        print(f"downloading {url}", file=sys.stderr)
        tmp = gz_path.with_suffix(gz_path.suffix + ".part")
        with urllib.request.urlopen(url) as response, tmp.open("wb") as handle:
            shutil.copyfileobj(response, handle)
        tmp.replace(gz_path)
    else:
        print(f"using cached {gz_path}", file=sys.stderr)

    if not nc_path.exists():
        with gzip.open(gz_path, "rb") as src, nc_path.open("wb") as dst:
            shutil.copyfileobj(src, dst)

    return nc_path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_grid(nc_path: Path, variable: str = "tempanomaly") -> tuple[Grid, int]:
    """Read the source file into annual means, trimming any part-covered final year."""
    import xarray as xr

    with xr.open_dataset(nc_path, decode_times=True) as ds:
        da = ds[variable].transpose("time", "lat", "lon")
        monthly = da.values.astype(np.float64)
        month_years = da["time"].dt.year.values.astype(np.int64)
        month_numbers = da["time"].dt.month.values.astype(np.int64)
        lats = ds["lat"].values.astype(np.float64)
        lons = ds["lon"].values.astype(np.float64)

    years, annual = annual_means(monthly, month_years)
    years, annual, dropped = drop_incomplete_final_years(years, annual, month_years, month_numbers)
    return Grid(lats=lats, lons=lons, years=years, annual=annual), dropped


def write_outputs(grid: Grid, out_dir: Path, source_sha: str, dropped: int) -> tuple[Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    bin_path = out_dir / "gistemp_annual.bin"
    json_path = out_dir / "gistemp_annual.json"

    quantise(grid.annual).tofile(bin_path)

    meta = {
        "lats": [round(float(v), 4) for v in grid.lats],
        "lons": [round(float(v), 4) for v in grid.lons],
        "years": [int(v) for v in grid.years],
        "shape": [int(grid.years.size), int(grid.lats.size), int(grid.lons.size)],
        "layout": "[year][lat][lon], little-endian int16",
        "scale": SCALE,
        "missing": MISSING,
        "units": "degrees Celsius anomaly, stored as value * scale",
        "baseline": BASELINE,
        "min_months_per_year": MIN_MONTHS,
        "final_year_requires_months": MONTHS_PER_YEAR,
        "dropped_trailing_incomplete_years": dropped,
        "source": SOURCE_NAME,
        "source_url": SOURCE_URL,
        "source_sha256": source_sha,
        "licence": SOURCE_LICENCE,
        "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
    }
    json_path.write_text(json.dumps(meta, separators=(",", ":")) + "\n", encoding="utf-8")
    return bin_path, json_path


def summary_lines(grid: Grid, bin_path: Path, dropped: int) -> list[str]:
    """The 5-line build summary."""
    means = global_means(grid.annual, grid.lats)
    slope, first, last = trend_per_decade(grid.years, means, 1980)
    decades = missing_by_decade(grid.years, grid.annual)
    latest = int(grid.years[-1])

    cells = grid.lats.size * grid.lons.size
    size_mb = bin_path.stat().st_size / 1e6
    decade_text = "  ".join(f"{d}s {pct:.0f}%" for d, pct in decades)

    return [
        f"years      {int(grid.years[0])}-{latest} ({grid.years.size} years, "
        f"{dropped} trailing incomplete year(s) dropped)",
        f"grid       {grid.lats.size} lat x {grid.lons.size} lon = {cells} cells, "
        f"{cells * grid.years.size} cell-years, {size_mb:.2f} MB raw",
        f"missing    {decade_text}",
        f"global     {latest} anomaly vs {BASELINE} = {means[-1]:+.2f} degC "
        f"(area-weighted, cos-lat)",
        f"trend      {slope:+.3f} degC/decade over {first}-{last} "
        f"(sanity check: expect about +0.2)",
    ]


# --------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--input", type=Path, help="use this local NetCDF instead of downloading")
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE_DIR)
    parser.add_argument("--url", default=SOURCE_URL)
    parser.add_argument("--variable", default="tempanomaly")
    args = parser.parse_args(argv)

    nc_path = args.input if args.input else download(args.url, args.cache_dir)
    grid, dropped = read_grid(nc_path, args.variable)

    if grid.years.size == 0:
        print("no complete years in the source file", file=sys.stderr)
        return 1

    bin_path, json_path = write_outputs(grid, args.out_dir, sha256(nc_path), dropped)
    for line in summary_lines(grid, bin_path, dropped):
        print(line)
    print(f"wrote {bin_path} and {json_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
