// @vitest-environment happy-dom
// buildSparkline builds real SVG nodes, so this file needs a DOM.

import { describe, expect, it } from "vitest";

import { buildPrefixSums } from "../src/compute.js";
import { decodeGistemp, type GistempData, type GistempMeta } from "../src/data.js";
import {
  buildSparkline,
  describeLatitude,
  describeLongitude,
  explainMissing,
  inspectCell,
} from "../src/inspect.js";
import { buildPalette, paletteIndex, PALETTE_OPTIONS } from "../src/palette.js";
import type { ViewState } from "../src/url.js";

const MISSING = -32768;
const MIN_COVERAGE = 0.6;

const years = Array.from({ length: 20 }, (_, i) => 2000 + i);

/** Two cells, twenty years. `values[year][cell]` in °C; null means no reading. */
function makeData(values: (number | null)[][]): GistempData {
  const meta: GistempMeta = {
    lats: [10],
    lons: [-20, 40],
    years,
    shape: [years.length, 1, 2],
    scale: 100,
    missing: MISSING,
    baseline: "test",
    source: "test",
    licence: "test",
    built_at: "2026-09-05",
  };
  const flat = values.flat().map((v) => (v === null ? MISSING : Math.round(v * 100)));
  return decodeGistemp(meta, Int16Array.from(flat).buffer);
}

const state: ViewState = {
  baselineStart: 2000,
  baselineEnd: 2009,
  windowYears: 5,
  year: 2019,
  region: "world",
  limit: 2,
  palette: "rdbu",
};

function report(values: (number | null)[][], cell = 0) {
  const data = makeData(values);
  return {
    data,
    report: inspectCell(data, buildPrefixSums(data), state, MIN_COVERAGE, cell),
  };
}

describe("coordinate labels", () => {
  it("names the hemisphere", () => {
    expect(describeLatitude(45)).toBe("45°N");
    expect(describeLatitude(-45)).toBe("45°S");
    expect(describeLongitude(120)).toBe("120°E");
    expect(describeLongitude(-120)).toBe("120°W");
  });

  it("gives the equator and the meridians no hemisphere", () => {
    expect(describeLatitude(0)).toBe("0°");
    expect(describeLongitude(0)).toBe("0°");
    expect(describeLongitude(180)).toBe("180°");
    expect(describeLongitude(-180)).toBe("180°");
  });
});

describe("inspectCell", () => {
  it("reports the cell's coordinates", () => {
    const { report: first } = report(years.map((_, i) => [i, i]));
    const { report: second } = report(
      years.map((_, i) => [i, i]),
      1,
    );

    expect([first.lat, first.lon]).toEqual([10, -20]);
    expect([second.lat, second.lon]).toEqual([10, 40]);
  });

  it("gives the window mean minus the baseline mean", () => {
    // baseline 2000-2009 = mean(0..9) = 4.5; window 2015-2019 = mean(15..19) = 17
    const { report: r } = report(years.map((_, i) => [i, 0]));

    expect(r.value).toBeCloseTo(12.5, 5);
    expect(r.baseline.coverage).toBe(1);
    expect(r.window.coverage).toBe(1);
  });

  it("carries the whole annual series, with gaps as NaN", () => {
    const values = years.map((_, i) => [i === 3 ? null : i, 0]);
    const { report: r } = report(values);

    expect(r.series).toHaveLength(20);
    expect(r.series[0]).toBeCloseTo(0, 5);
    expect(r.series[3]).toBeNaN();
    expect(r.series[19]).toBeCloseTo(19, 5);
  });

  it("reads each cell's own series, not its neighbour's", () => {
    const values = years.map((_, i) => [i, -i]);

    expect(report(values, 0).report.series[19]).toBeCloseTo(19, 5);
    expect(report(values, 1).report.series[19]).toBeCloseTo(-19, 5);
  });

  it("is NaN when the cell is unusable, but still reports coverage", () => {
    // only 3 of the 10 baseline years present
    const values = years.map((_, i) => [i < 10 && i >= 3 ? null : i, 0]);
    const { report: r } = report(values);

    expect(r.value).toBeNaN();
    expect(r.baseline.coverage).toBeCloseTo(0.3, 5);
  });
});

describe("explainMissing", () => {
  it("says nothing when the cell is fine", () => {
    const { report: r } = report(years.map((_, i) => [i, 0]));

    expect(explainMissing(r, state, MIN_COVERAGE)).toBeNull();
  });

  it("names the baseline period and its coverage", () => {
    const values = years.map((_, i) => [i >= 3 && i < 10 ? null : i, 0]);
    const { report: r } = report(values);

    expect(explainMissing(r, state, MIN_COVERAGE)).toBe(
      "no data in baseline 2000–2009 (coverage 30%)",
    );
  });

  it("names the window period and its coverage", () => {
    const values = years.map((_, i) => [i >= 15 && i < 19 ? null : i, 0]);
    const { report: r } = report(values);

    expect(explainMissing(r, state, MIN_COVERAGE)).toBe(
      "no data in window 2015–2019 (coverage 20%)",
    );
  });

  it("blames the baseline first when both fail", () => {
    const { report: r } = report(years.map(() => [null, 0]));

    expect(explainMissing(r, state, MIN_COVERAGE)).toMatch(/^no data in baseline/);
  });

  it("writes a one-year window as a single year", () => {
    const single = { ...state, windowYears: 1 as const, year: 2019 };
    const values = years.map((_, i) => [i === 19 ? null : i, 0]);
    const data = makeData(values);
    const r = inspectCell(data, buildPrefixSums(data), single, MIN_COVERAGE, 0);

    expect(explainMissing(r, single, MIN_COVERAGE)).toBe("no data in window 2019 (coverage 0%)");
  });
});

describe("palettes", () => {
  it("offers a colour-blind-safe alternative alongside the default", () => {
    expect(PALETTE_OPTIONS).toEqual(["rdbu", "puor"]);
  });

  it.each(PALETTE_OPTIONS)("runs cool to warm in the same direction: %s", (name) => {
    const lut = buildPalette(name);
    const cold = paletteIndex(-2, 2) * 3;
    const warm = paletteIndex(2, 2) * 3;

    // Cool end is blue- or purple-dominant; warm end is red- or orange-dominant.
    expect(lut[cold + 2]!).toBeGreaterThan(lut[cold]!);
    expect(lut[warm]!).toBeGreaterThan(lut[warm + 2]!);
  });

  it("keeps the two ramps visibly different at the warm end", () => {
    const warm = paletteIndex(2, 2) * 3;
    const rdbu = buildPalette("rdbu");
    const puor = buildPalette("puor");

    const distance =
      Math.abs(rdbu[warm]! - puor[warm]!) +
      Math.abs(rdbu[warm + 1]! - puor[warm + 1]!) +
      Math.abs(rdbu[warm + 2]! - puor[warm + 2]!);

    expect(distance).toBeGreaterThan(30);
  });

  it("puts purple, not blue, at the cool end of PuOr", () => {
    const cold = paletteIndex(-2, 2) * 3;
    const puor = buildPalette("puor");

    // Purple has real red in it; RdBu's blue does not.
    expect(puor[cold]!).toBeGreaterThan(buildPalette("rdbu")[cold]!);
  });
});

describe("buildSparkline", () => {
  const allYears = years;

  it("draws a chart when the cell has readings", () => {
    const { report: r, data } = report(allYears.map((_, i) => [i, 0]));

    const svg = buildSparkline(r, data.meta.years, state);

    expect(svg).not.toBeNull();
    expect(svg!.querySelector(".spark-line")).not.toBeNull();
    expect(svg!.querySelector(".spark-band")).not.toBeNull();
  });

  it("returns nothing when the cell has no readings at all", () => {
    const { report: r, data } = report(allYears.map(() => [null, 0]));

    expect(buildSparkline(r, data.meta.years, state)).toBeNull();
  });

  it("breaks the line at a gap rather than drawing through it", () => {
    const values = allYears.map((_, i) => [i >= 5 && i < 9 ? null : i, 0]);
    const { report: r, data } = report(values);

    const path = buildSparkline(r, data.meta.years, state)!.querySelector(".spark-line")!;
    const moves = (path.getAttribute("d") ?? "").match(/M/g) ?? [];

    expect(moves).toHaveLength(2); // one run before the gap, one after
  });
});
