/**
 * Turning the raw cell-year grid into one anomaly field.
 *
 * Every view is two means per cell: the mean over the baseline years and the
 * mean over the rolling window, with the anomaly their difference. Both are
 * answered in O(1) from prefix sums built once when the data loads, so changing
 * the baseline or the window is a pass over the cells rather than over the
 * cell-years.
 *
 * The sums are kept in the source's own integer units (°C x scale), so they are
 * exact: 146 years of int16 anomalies cannot overflow an Int32.
 */

import type { GistempData } from "./data.js";

/** A cell-year counts towards a mean only if the source has a value for it. */
export interface PrefixSums {
  readonly nCells: number;
  readonly nYears: number;
  /** [(year + 1) * nCells + cell] cumulative sum of present values, raw units. */
  readonly sums: Int32Array;
  /** [(year + 1) * nCells + cell] cumulative count of present values. */
  readonly counts: Uint16Array;
  readonly scale: number;
}

export interface Span {
  /** Mean in °C over the present years, or NaN if none were present. */
  readonly mean: number;
  /** Fraction of the requested years the source actually has, 0..1. */
  readonly coverage: number;
}

export interface FieldOptions {
  /** Inclusive calendar years. */
  readonly baselineStart: number;
  readonly baselineEnd: number;
  /** Length of the rolling window in years; the window ends at `year`. */
  readonly windowYears: number;
  readonly year: number;
  /** A cell is missing below this fraction of present years. */
  readonly minCoverage: number;
}

export const DEFAULT_MIN_COVERAGE = 0.6;

export function buildPrefixSums(data: GistempData): PrefixSums {
  const nCells = data.nLats * data.nLons;
  const { nYears, values } = data;
  const missing = data.meta.missing;

  const sums = new Int32Array((nYears + 1) * nCells);
  const counts = new Uint16Array((nYears + 1) * nCells);

  for (let year = 0; year < nYears; year++) {
    const prev = year * nCells;
    const next = (year + 1) * nCells;
    for (let cell = 0; cell < nCells; cell++) {
      const raw = values[prev + cell]!;
      const present = raw !== missing;
      sums[next + cell] = sums[prev + cell]! + (present ? raw : 0);
      counts[next + cell] = counts[prev + cell]! + (present ? 1 : 0);
    }
  }

  return { nCells, nYears, sums, counts, scale: data.meta.scale };
}

/**
 * Mean over year indices [from, to] inclusive, clamped to the record.
 * Coverage is measured against the years actually asked for, before clamping,
 * so a window that runs off the start of the record is correctly under-covered.
 */
export function meanOverYears(prefix: PrefixSums, cell: number, from: number, to: number): Span {
  const requested = to - from + 1;
  if (requested <= 0) return { mean: Number.NaN, coverage: 0 };

  const lo = Math.max(0, from);
  const hi = Math.min(prefix.nYears - 1, to);
  if (lo > hi) return { mean: Number.NaN, coverage: 0 };

  const start = lo * prefix.nCells + cell;
  const end = (hi + 1) * prefix.nCells + cell;
  const present = prefix.counts[end]! - prefix.counts[start]!;
  if (present === 0) return { mean: Number.NaN, coverage: 0 };

  const total = prefix.sums[end]! - prefix.sums[start]!;
  return { mean: total / present / prefix.scale, coverage: present / requested };
}

/** Index of a calendar year in the record, or -1. Years are contiguous and ascending. */
export function yearIndex(data: GistempData, year: number): number {
  const first = data.meta.years[0];
  if (first === undefined) return -1;
  const index = year - first;
  return index >= 0 && index < data.nYears ? index : -1;
}

/**
 * The anomaly field for one view: rolling-window mean minus baseline mean, in °C.
 * Cells below `minCoverage` in either period come back as NaN — a gap in the
 * record must read as "no data", never as zero change.
 */
export function computeField(
  data: GistempData,
  prefix: PrefixSums,
  options: FieldOptions,
): Float32Array {
  const baseFrom = yearIndex(data, options.baselineStart);
  const baseTo = yearIndex(data, options.baselineEnd);
  const windowEnd = yearIndex(data, options.year);
  const windowStart = windowEnd - (options.windowYears - 1);

  const field = new Float32Array(prefix.nCells).fill(Number.NaN);
  if (baseFrom < 0 || baseTo < 0 || windowEnd < 0) return field;

  for (let cell = 0; cell < prefix.nCells; cell++) {
    const baseline = meanOverYears(prefix, cell, baseFrom, baseTo);
    if (baseline.coverage < options.minCoverage) continue;

    const window = meanOverYears(prefix, cell, windowStart, windowEnd);
    if (window.coverage < options.minCoverage) continue;

    field[cell] = window.mean - baseline.mean;
  }

  return field;
}

/** Area-weighted global mean of a field, for the sanity line under the map. */
export function fieldGlobalMean(field: Float32Array, lats: readonly number[], nLons: number): number {
  let weighted = 0;
  let weight = 0;
  for (let lat = 0; lat < lats.length; lat++) {
    const w = Math.cos((lats[lat]! * Math.PI) / 180);
    const row = lat * nLons;
    for (let lon = 0; lon < nLons; lon++) {
      const value = field[row + lon]!;
      if (Number.isNaN(value)) continue;
      weighted += value * w;
      weight += w;
    }
  }
  return weight > 0 ? weighted / weight : Number.NaN;
}
