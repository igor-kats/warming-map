"""Tests for scripts/build_gistemp.py, including an end-to-end run on a tiny synthetic NetCDF."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import build_gistemp as bg  # noqa: E402


# --------------------------------------------------------------------------
# annual_means
# --------------------------------------------------------------------------


def test_annual_mean_of_a_full_year():
    monthly = np.arange(12, dtype=np.float64).reshape(12, 1, 1)
    years = np.full(12, 2000, dtype=np.int64)

    out_years, annual = bg.annual_means(monthly, years)

    assert out_years.tolist() == [2000]
    assert annual[0, 0, 0] == pytest.approx(5.5)


def test_year_with_fewer_than_nine_months_is_missing():
    monthly = np.full((12, 1, 1), 1.0)
    monthly[:4] = np.nan  # 8 months present
    years = np.full(12, 2000, dtype=np.int64)

    _, annual = bg.annual_means(monthly, years)

    assert np.isnan(annual[0, 0, 0])


def test_year_with_exactly_nine_months_counts():
    monthly = np.full((12, 1, 1), 2.0)
    monthly[:3] = np.nan  # 9 months present
    years = np.full(12, 2000, dtype=np.int64)

    _, annual = bg.annual_means(monthly, years)

    assert annual[0, 0, 0] == pytest.approx(2.0)


def test_the_month_threshold_is_per_cell():
    monthly = np.full((12, 1, 2), 3.0)
    monthly[:5, 0, 1] = np.nan  # second cell has only 7 months
    years = np.full(12, 2000, dtype=np.int64)

    _, annual = bg.annual_means(monthly, years)

    assert annual[0, 0, 0] == pytest.approx(3.0)
    assert np.isnan(annual[0, 0, 1])


def test_years_are_separated_and_sorted():
    monthly = np.concatenate([np.full((12, 1, 1), 1.0), np.full((12, 1, 1), 5.0)])
    years = np.concatenate([np.full(12, 2001), np.full(12, 2000)]).astype(np.int64)

    out_years, annual = bg.annual_means(monthly, years)

    assert out_years.tolist() == [2000, 2001]
    assert annual[0, 0, 0] == pytest.approx(5.0)
    assert annual[1, 0, 0] == pytest.approx(1.0)


def test_annual_means_rejects_a_bad_shape():
    with pytest.raises(ValueError):
        bg.annual_means(np.zeros((12, 1)), np.zeros(12, dtype=np.int64))


# --------------------------------------------------------------------------
# quantise
# --------------------------------------------------------------------------


def test_quantise_scales_rounds_and_marks_missing():
    annual = np.array([[[0.0, 1.234, -1.235, np.nan]]])

    out = bg.quantise(annual)

    assert out.dtype == np.dtype("<i2")
    assert out.ravel().tolist() == [0, 123, -124, bg.MISSING]


def test_quantise_rejects_values_beyond_int16():
    with pytest.raises(ValueError):
        bg.quantise(np.array([[[400.0]]]))


# --------------------------------------------------------------------------
# global means, trend, missing
# --------------------------------------------------------------------------


def test_global_mean_weights_by_cos_latitude():
    lats = np.array([-60.0, 0.0, 60.0])
    annual = np.array([[[0.0], [2.0], [0.0]]])

    got = bg.global_means(annual, lats)

    weights = np.cos(np.deg2rad(lats))
    assert got[0] == pytest.approx(2.0 * weights[1] / weights.sum())


def test_global_mean_ignores_missing_cells():
    lats = np.array([0.0, 0.0])
    annual = np.array([[[1.0], [np.nan]]])

    assert bg.global_means(annual, lats)[0] == pytest.approx(1.0)


def test_global_mean_of_an_empty_year_is_nan():
    annual = np.array([[[np.nan]]])

    assert np.isnan(bg.global_means(annual, np.array([0.0]))[0])


def test_trend_per_decade_recovers_a_known_slope():
    years = np.arange(1980, 2000)
    series = 0.02 * (years - 1980)  # 0.02 degC/year

    slope, first, last = bg.trend_per_decade(years, series, 1980)

    assert slope == pytest.approx(0.2)
    assert (first, last) == (1980, 1999)


def test_trend_ignores_years_before_the_cutoff():
    years = np.arange(1900, 2000)
    series = np.where(years < 1980, 100.0, 0.03 * (years - 1980))

    slope, first, _ = bg.trend_per_decade(years, series, 1980)

    assert slope == pytest.approx(0.3)
    assert first == 1980


def test_trend_is_nan_without_two_points():
    slope, _, _ = bg.trend_per_decade(np.array([1990]), np.array([1.0]), 1980)

    assert np.isnan(slope)


def test_missing_by_decade_counts_cell_years():
    years = np.array([1880, 1881, 1890])
    annual = np.array([[[np.nan, 1.0]], [[1.0, 1.0]], [[np.nan, np.nan]]])

    assert bg.missing_by_decade(years, annual) == [(1880, 25.0), (1890, 100.0)]


# --------------------------------------------------------------------------
# the final-year coverage rule
# --------------------------------------------------------------------------


def month_axis(spans: list[tuple[int, int]]) -> tuple[np.ndarray, np.ndarray]:
    """Build (month_years, month_numbers) from [(year, months_present), ...]."""
    years, months = [], []
    for year, count in spans:
        years.extend([year] * count)
        months.extend(range(1, count + 1))
    return np.array(years, dtype=np.int64), np.array(months, dtype=np.int64)


def test_a_final_year_short_of_twelve_months_is_dropped():
    years = np.array([2000, 2001])
    annual = np.array([[[1.0]], [[2.0]]])  # both years have data
    month_years, month_numbers = month_axis([(2000, 12), (2001, 9)])

    kept_years, kept, dropped = bg.drop_incomplete_final_years(
        years, annual, month_years, month_numbers
    )

    assert kept_years.tolist() == [2000]
    assert kept.shape == (1, 1, 1)
    assert dropped == 1


def test_a_final_year_with_twelve_months_is_kept():
    years = np.array([2000, 2001])
    annual = np.array([[[1.0]], [[2.0]]])
    month_years, month_numbers = month_axis([(2000, 12), (2001, 12)])

    kept_years, _, dropped = bg.drop_incomplete_final_years(
        years, annual, month_years, month_numbers
    )

    assert kept_years.tolist() == [2000, 2001]
    assert dropped == 0


def test_the_rule_overrides_min_months():
    """Eleven months would clear MIN_MONTHS for every cell; the tail rule still drops it."""
    years = np.array([2000, 2001])
    annual = np.array([[[1.0]], [[2.0]]])
    month_years, month_numbers = month_axis([(2000, 12), (2001, 11)])

    kept_years, _, dropped = bg.drop_incomplete_final_years(
        years, annual, month_years, month_numbers
    )

    assert kept_years.tolist() == [2000]
    assert dropped == 1


def test_a_fully_missing_but_fully_covered_final_year_is_kept():
    """Coverage is a property of the time axis, not of how much data survived."""
    years = np.array([2000, 2001])
    annual = np.array([[[1.0]], [[np.nan]]])
    month_years, month_numbers = month_axis([(2000, 12), (2001, 12)])

    kept_years, _, dropped = bg.drop_incomplete_final_years(
        years, annual, month_years, month_numbers
    )

    assert kept_years.tolist() == [2000, 2001]
    assert dropped == 0


def test_trimming_stops_at_the_first_complete_year():
    """An interior year the source covers only partly is left alone."""
    years = np.array([2000, 2001, 2002])
    annual = np.array([[[1.0]], [[2.0]], [[3.0]]])
    month_years, month_numbers = month_axis([(2000, 7), (2001, 12), (2002, 4)])

    kept_years, _, dropped = bg.drop_incomplete_final_years(
        years, annual, month_years, month_numbers
    )

    assert kept_years.tolist() == [2000, 2001]
    assert dropped == 1


def test_duplicate_timesteps_do_not_fake_coverage():
    """Twelve rows spanning only six distinct months is not a covered year."""
    years = np.array([2000])
    annual = np.array([[[1.0]]])
    month_years = np.full(12, 2000, dtype=np.int64)
    month_numbers = np.tile(np.arange(1, 7), 2).astype(np.int64)

    kept_years, _, dropped = bg.drop_incomplete_final_years(
        years, annual, month_years, month_numbers
    )

    assert kept_years.tolist() == []
    assert dropped == 1


# --------------------------------------------------------------------------
# end to end on a synthetic NetCDF
# --------------------------------------------------------------------------

SYNTH_LATS = [-45.0, 0.0, 45.0]
SYNTH_LONS = [-90.0, 0.0, 90.0]
SYNTH_YEARS = list(range(1980, 1990))


def write_synthetic_nc(path: Path, final_months: int) -> Path:
    """A tiny GISTEMP-shaped file: 3x3 cells, 10 years, a known linear warming trend.

    Cell values rise 0.02 degC/year everywhere, so the area-weighted global trend
    must come back as +0.2 degC/decade. One cell-year is deliberately short of
    months, and `final_months` sets how much of the last year the time axis covers.
    """
    xr = pytest.importorskip("xarray")
    pytest.importorskip("netCDF4")

    times, values = [], []
    for year in SYNTH_YEARS:
        months = final_months if year == SYNTH_YEARS[-1] else 12
        for month in range(1, months + 1):
            times.append(np.datetime64(f"{year}-{month:02d}-15"))
            frame = np.full((3, 3), 0.02 * (year - SYNTH_YEARS[0]))
            if year == 1985 and month <= 5:
                frame[0, 0] = np.nan  # only 7 months for that cell-year
            values.append(frame)

    da = xr.DataArray(
        np.array(values, dtype=np.float32),
        dims=("time", "lat", "lon"),
        coords={"time": np.array(times), "lat": SYNTH_LATS, "lon": SYNTH_LONS},
        name="tempanomaly",
    )
    da.to_dataset().to_netcdf(path)
    return path


@pytest.fixture
def synthetic_nc(tmp_path: Path) -> Path:
    """The default file: the last year has nine months, which MIN_MONTHS alone would accept."""
    return write_synthetic_nc(tmp_path / "synthetic.nc", final_months=9)


def build_meta(nc_path: Path, out_dir: Path) -> dict:
    assert bg.main(["--input", str(nc_path), "--out-dir", str(out_dir)]) == 0
    return json.loads((out_dir / "gistemp_annual.json").read_text())


def test_a_nine_month_final_year_is_dropped(tmp_path: Path):
    """Nine months clears MIN_MONTHS, so only the tail rule can reject this year."""
    nc_path = write_synthetic_nc(tmp_path / "nine.nc", final_months=9)

    meta = build_meta(nc_path, tmp_path / "out")

    assert meta["years"] == SYNTH_YEARS[:-1]
    assert meta["years"][-1] == 1988
    assert meta["dropped_trailing_incomplete_years"] == 1
    assert meta["shape"] == [9, 3, 3]


def test_a_twelve_month_final_year_is_kept(tmp_path: Path):
    nc_path = write_synthetic_nc(tmp_path / "twelve.nc", final_months=12)

    meta = build_meta(nc_path, tmp_path / "out")

    assert meta["years"] == SYNTH_YEARS
    assert meta["years"][-1] == 1989
    assert meta["dropped_trailing_incomplete_years"] == 0
    assert meta["shape"] == [10, 3, 3]


def test_end_to_end_writes_the_expected_binary(synthetic_nc: Path, tmp_path: Path, capsys):
    out_dir = tmp_path / "out"

    assert bg.main(["--input", str(synthetic_nc), "--out-dir", str(out_dir)]) == 0

    meta = json.loads((out_dir / "gistemp_annual.json").read_text())
    assert meta["shape"] == [9, 3, 3]  # the incomplete 1989 was dropped
    assert meta["years"] == SYNTH_YEARS[:-1]
    assert meta["dropped_trailing_incomplete_years"] == 1
    assert meta["scale"] == 100 and meta["missing"] == -32768
    assert meta["lats"] == SYNTH_LATS and meta["lons"] == SYNTH_LONS

    raw = np.fromfile(out_dir / "gistemp_annual.bin", dtype="<i2").reshape(meta["shape"])
    assert raw.size == 9 * 3 * 3
    assert raw[0, 1, 1] == 0  # 1980 is the baseline year of the synthetic ramp
    assert raw[8, 1, 1] == 16  # 1988: 0.02 * 8 = 0.16 degC
    assert raw[5, 0, 0] == bg.MISSING  # the 7-month cell-year


def test_end_to_end_reports_the_expected_trend(synthetic_nc: Path, tmp_path: Path, capsys):
    bg.main(["--input", str(synthetic_nc), "--out-dir", str(tmp_path / "out")])

    out = capsys.readouterr().out
    lines = out.strip().splitlines()

    assert len(lines) == 5, out
    assert lines[0].startswith("years      1980-1988")
    assert "+0.200 degC/decade over 1980-1988" in lines[4]


def test_the_build_is_deterministic(synthetic_nc: Path, tmp_path: Path):
    first, second = tmp_path / "a", tmp_path / "b"
    bg.main(["--input", str(synthetic_nc), "--out-dir", str(first)])
    bg.main(["--input", str(synthetic_nc), "--out-dir", str(second)])

    assert (first / "gistemp_annual.bin").read_bytes() == (second / "gistemp_annual.bin").read_bytes()
    assert (first / "gistemp_annual.json").read_text() == (second / "gistemp_annual.json").read_text()


def test_download_refuses_a_url_that_is_not_gzipped(tmp_path: Path):
    with pytest.raises(ValueError, match="gzipped NetCDF"):
        bg.download("https://example.invalid/plain.nc", tmp_path)
