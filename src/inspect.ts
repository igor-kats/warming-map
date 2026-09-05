/**
 * The per-cell panel: where you are, what changed, and the cell's whole record.
 *
 * A single number on a map invites the reader to trust it. The sparkline is
 * there to undercut that a little — it shows the year-to-year noise the window
 * average is smoothing over, and the gaps in the record, so the reader can see
 * how much the cell's figure is worth.
 *
 * When a cell is grey the panel says which period failed and by how much,
 * rather than leaving "no data" to be read as "nothing happened here".
 */

import { meanOverYears, yearIndex, type PrefixSums, type Span } from "./compute.js";
import type { GistempData } from "./data.js";
import { cssFor } from "./palette.js";
import type { ViewState } from "./url.js";

export interface CellReport {
  readonly cell: number;
  readonly lat: number;
  readonly lon: number;
  /** Anomaly in °C, or NaN if the cell is missing under the current view. */
  readonly value: number;
  readonly baseline: Span;
  readonly window: Span;
  /** The cell's annual series across the whole record, NaN where absent. */
  readonly series: Float32Array;
}

const SPARK_WIDTH = 220;
const SPARK_HEIGHT = 46;
const SVG_NS = "http://www.w3.org/2000/svg";

export function describeLatitude(lat: number): string {
  const rounded = Math.abs(lat).toFixed(0);
  if (Math.abs(lat) < 0.5) return "0°";
  return `${rounded}°${lat > 0 ? "N" : "S"}`;
}

export function describeLongitude(lon: number): string {
  const rounded = Math.abs(lon).toFixed(0);
  if (Math.abs(lon) < 0.5) return "0°";
  if (Math.abs(Math.abs(lon) - 180) < 0.5) return "180°";
  return `${rounded}°${lon > 0 ? "E" : "W"}`;
}

function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/**
 * Why a cell is grey, in words, or null when it is not.
 * The baseline is reported first: if both periods fail, the baseline is the one
 * that makes the cell unusable for every year, not just this one.
 */
export function explainMissing(report: CellReport, state: ViewState, minCoverage: number): string | null {
  if (report.baseline.coverage < minCoverage) {
    return (
      `no data in baseline ${state.baselineStart}–${state.baselineEnd} ` +
      `(coverage ${percent(report.baseline.coverage)})`
    );
  }

  if (report.window.coverage < minCoverage) {
    const from = state.year - state.windowYears + 1;
    const span = state.windowYears === 1 ? `${state.year}` : `${from}–${state.year}`;
    return `no data in window ${span} (coverage ${percent(report.window.coverage)})`;
  }

  return null;
}

/** Everything the panel needs about one cell under the current view. */
export function inspectCell(
  data: GistempData,
  prefix: PrefixSums,
  state: ViewState,
  minCoverage: number,
  cell: number,
): CellReport {
  const nLons = data.nLons;
  const lat = data.meta.lats[Math.floor(cell / nLons)] ?? Number.NaN;
  const lon = data.meta.lons[cell % nLons] ?? Number.NaN;

  const baseFrom = yearIndex(data, state.baselineStart);
  const baseTo = yearIndex(data, state.baselineEnd);
  const windowEnd = yearIndex(data, state.year);
  const windowStart = windowEnd - (state.windowYears - 1);

  const baseline =
    baseFrom < 0 || baseTo < 0
      ? { mean: Number.NaN, coverage: 0 }
      : meanOverYears(prefix, cell, baseFrom, baseTo);
  const window =
    windowEnd < 0
      ? { mean: Number.NaN, coverage: 0 }
      : meanOverYears(prefix, cell, windowStart, windowEnd);

  const usable = baseline.coverage >= minCoverage && window.coverage >= minCoverage;

  const series = new Float32Array(data.nYears);
  const nCells = data.nLats * nLons;
  for (let y = 0; y < data.nYears; y++) {
    const raw = data.values[y * nCells + cell]!;
    series[y] = raw === data.meta.missing ? Number.NaN : raw / data.meta.scale;
  }

  return {
    cell,
    lat,
    lon,
    value: usable ? window.mean - baseline.mean : Number.NaN,
    baseline,
    window,
    series,
  };
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

/**
 * The cell's annual series, with the baseline years shaded and the current
 * window marked. Gaps in the record are gaps in the line, never zeros.
 */
export function buildSparkline(
  report: CellReport,
  years: readonly number[],
  state: ViewState,
): SVGSVGElement | null {
  const present = Array.from(report.series).filter(Number.isFinite);
  // Nothing to draw. An empty chart box reads as a rendering fault, so the
  // caller says so in words instead.
  if (present.length === 0) return null;

  const svg = svgEl("svg", {
    viewBox: `0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`,
    width: SPARK_WIDTH,
    height: SPARK_HEIGHT,
    class: "spark",
    role: "img",
    "aria-label": `Annual anomalies for this cell, ${years[0]} to ${years[years.length - 1]}`,
  });

  const lo = Math.min(...present, 0);
  const hi = Math.max(...present, 0);
  const pad = (hi - lo) * 0.12 || 0.5;
  const top = hi + pad;
  const bottom = lo - pad;

  const first = years[0] ?? 0;
  const last = years[years.length - 1] ?? 1;
  const x = (year: number): number =>
    last === first ? 0 : ((year - first) / (last - first)) * SPARK_WIDTH;
  const y = (value: number): number =>
    top === bottom ? SPARK_HEIGHT / 2 : ((top - value) / (top - bottom)) * SPARK_HEIGHT;

  // Baseline years, shaded.
  const bandLeft = x(state.baselineStart);
  const bandRight = x(state.baselineEnd);
  svg.append(
    svgEl("rect", {
      x: bandLeft,
      y: 0,
      width: Math.max(1, bandRight - bandLeft),
      height: SPARK_HEIGHT,
      class: "spark-band",
    }),
  );

  // Zero line, so the reader can see which side of the baseline a year sits on.
  svg.append(
    svgEl("line", { x1: 0, x2: SPARK_WIDTH, y1: y(0), y2: y(0), class: "spark-zero" }),
  );

  // The series, broken wherever the record is.
  let path = "";
  let pen = "M";
  for (let i = 0; i < report.series.length; i++) {
    const value = report.series[i]!;
    if (!Number.isFinite(value)) {
      pen = "M";
      continue;
    }
    path += `${pen}${x(years[i] ?? 0).toFixed(1)},${y(value).toFixed(1)}`;
    pen = "L";
  }
  if (path) svg.append(svgEl("path", { d: path, class: "spark-line" }));

  // The year on show.
  const current = x(state.year);
  svg.append(
    svgEl("line", { x1: current, x2: current, y1: 0, y2: SPARK_HEIGHT, class: "spark-now" }),
  );

  return svg;
}

/** Render the panel's contents for one cell. */
export function renderPanel(
  host: HTMLElement,
  report: CellReport,
  data: GistempData,
  state: ViewState,
  lut: Uint8ClampedArray,
  minCoverage: number,
): void {
  host.replaceChildren();

  const place = document.createElement("div");
  place.className = "panel-place";
  place.textContent = `${describeLatitude(report.lat)}, ${describeLongitude(report.lon)}`;

  const value = document.createElement("div");
  value.className = "panel-value";

  const reason = explainMissing(report, state, minCoverage);
  if (reason) {
    value.classList.add("panel-missing");
    value.textContent = reason;
  } else {
    const sign = report.value >= 0 ? "+" : "−";
    const swatch = document.createElement("i");
    swatch.style.background = cssFor(report.value, state.limit, lut);
    value.append(
      swatch,
      document.createTextNode(`${sign}${Math.abs(report.value).toFixed(2)} °C vs baseline`),
    );
  }

  host.append(place, value);

  const spark = buildSparkline(report, data.meta.years, state);
  const note = document.createElement("div");
  note.className = "panel-note";

  if (spark) {
    const from = state.year - state.windowYears + 1;
    const span = state.windowYears === 1 ? `${state.year}` : `${from}–${state.year}`;
    note.textContent = `${span} against ${state.baselineStart}–${state.baselineEnd} (shaded)`;
    host.append(spark, note);
  } else {
    note.textContent = "This cell has no readings in any year of the record.";
    host.append(note);
  }
}
