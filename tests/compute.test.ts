import { describe, expect, it } from "vitest";

import {
  buildPrefixSums,
  computeField,
  fieldGlobalMean,
  meanOverYears,
  yearIndex,
} from "../src/compute.js";
import { decodeGistemp, type GistempData, type GistempMeta } from "../src/data.js";

const MISSING = -32768;

/**
 * Build a GistempData over `years` with one cell per lat/lon pair.
 * `values[year][cell]` is in °C; null means the source has no reading.
 */
function makeData(
  years: number[],
  lats: number[],
  lons: number[],
  values: (number | null)[][],
): GistempData {
  const meta: GistempMeta = {
    lats,
    lons,
    years,
    shape: [years.length, lats.length, lons.length],
    scale: 100,
    missing: MISSING,
    baseline: "1951-1980",
    source: "test",
    licence: "test",
    built_at: "2026-09-05",
  };
  const flat = values.flat().map((v) => (v === null ? MISSING : Math.round(v * 100)));
  return decodeGistemp(meta, Int16Array.from(flat).buffer);
}

/** One cell, ten years 2000-2009, value = year - 2000 in °C. */
function ramp(): GistempData {
  const years = Array.from({ length: 10 }, (_, i) => 2000 + i);
  return makeData(years, [0], [0], years.map((_, i) => [i]));
}

describe("yearIndex", () => {
  it("maps calendar years onto the record", () => {
    const data = ramp();

    expect(yearIndex(data, 2000)).toBe(0);
    expect(yearIndex(data, 2009)).toBe(9);
  });

  it("rejects years outside the record", () => {
    const data = ramp();

    expect(yearIndex(data, 1999)).toBe(-1);
    expect(yearIndex(data, 2010)).toBe(-1);
  });
});

describe("meanOverYears", () => {
  it("averages an inclusive span", () => {
    const prefix = buildPrefixSums(ramp());

    // years 2..5 hold 2, 3, 4, 5
    expect(meanOverYears(prefix, 0, 2, 5).mean).toBeCloseTo(3.5, 10);
    expect(meanOverYears(prefix, 0, 2, 5).coverage).toBe(1);
  });

  it("is exact for a single year", () => {
    const prefix = buildPrefixSums(ramp());

    expect(meanOverYears(prefix, 0, 7, 7).mean).toBeCloseTo(7, 10);
  });

  it("averages only the present years and reports coverage", () => {
    const data = makeData([2000, 2001, 2002, 2003], [0], [0], [[4], [null], [null], [8]]);
    const prefix = buildPrefixSums(data);

    const span = meanOverYears(prefix, 0, 0, 3);

    expect(span.mean).toBeCloseTo(6, 10); // (4 + 8) / 2, not / 4
    expect(span.coverage).toBeCloseTo(0.5, 10);
  });

  it("counts years asked for but off the start of the record as missing", () => {
    const prefix = buildPrefixSums(ramp());

    // a 5-year window ending at index 1 reaches back to index -3
    const span = meanOverYears(prefix, 0, -3, 1);

    expect(span.mean).toBeCloseTo(0.5, 10); // only years 0 and 1 exist
    expect(span.coverage).toBeCloseTo(0.4, 10); // 2 of the 5 requested
  });

  it("returns NaN when nothing is present", () => {
    const data = makeData([2000, 2001], [0], [0], [[null], [null]]);
    const prefix = buildPrefixSums(data);

    const span = meanOverYears(prefix, 0, 0, 1);

    expect(span.mean).toBeNaN();
    expect(span.coverage).toBe(0);
  });

  it("handles a reversed span without inventing an answer", () => {
    const prefix = buildPrefixSums(ramp());

    expect(meanOverYears(prefix, 0, 5, 4).mean).toBeNaN();
  });
});

describe("computeField", () => {
  const options = {
    baselineStart: 2000,
    baselineEnd: 2003,
    windowYears: 3,
    year: 2009,
    minCoverage: 0.6,
  };

  it("subtracts the baseline mean from the window mean", () => {
    const field = (() => {
      const data = ramp();
      return computeField(data, buildPrefixSums(data), options);
    })();

    // window 2007-2009 = mean(7,8,9) = 8; baseline 2000-2003 = mean(0,1,2,3) = 1.5
    expect(field[0]).toBeCloseTo(6.5, 5);
  });

  it("re-centres rather than rescaling: a constant offset shifts every cell equally", () => {
    const years = Array.from({ length: 10 }, (_, i) => 2000 + i);
    const shifted = makeData(years, [0], [0], years.map((_, i) => [i + 5]));

    const field = computeField(shifted, buildPrefixSums(shifted), options);

    expect(field[0]).toBeCloseTo(6.5, 5); // unchanged: +5 cancels in the difference
  });

  it("marks a cell missing when the window is under-covered", () => {
    const years = Array.from({ length: 10 }, (_, i) => 2000 + i);
    const holes = years.map((_, i) => [i >= 7 && i <= 8 ? null : i]);
    const data = makeData(years, [0], [0], holes);

    // window 2007-2009 keeps only 1 of 3 years = 0.33 coverage
    const field = computeField(data, buildPrefixSums(data), options);

    expect(field[0]).toBeNaN();
  });

  it("marks a cell missing when the baseline is under-covered", () => {
    const years = Array.from({ length: 10 }, (_, i) => 2000 + i);
    const holes = years.map((_, i) => [i <= 2 ? null : i]);
    const data = makeData(years, [0], [0], holes);

    // baseline 2000-2003 keeps only 1 of 4 years = 0.25 coverage
    const field = computeField(data, buildPrefixSums(data), options);

    expect(field[0]).toBeNaN();
  });

  it("keeps a cell that clears the coverage bar exactly", () => {
    const years = Array.from({ length: 10 }, (_, i) => 2000 + i);
    const holes = years.map((_, i) => [i === 0 ? null : i]);
    const data = makeData(years, [0], [0], holes);

    // baseline keeps 3 of 4 = 0.75, window is whole
    const field = computeField(data, buildPrefixSums(data), options);

    expect(field[0]).toBeCloseTo(8 - 2, 5); // baseline mean(1,2,3) = 2
  });

  it("returns an all-missing field when the years are outside the record", () => {
    const data = ramp();

    const field = computeField(data, buildPrefixSums(data), { ...options, year: 2050 });

    expect(field[0]).toBeNaN();
  });

  it("computes each cell independently", () => {
    const years = Array.from({ length: 10 }, (_, i) => 2000 + i);
    // two cells: one warming, one cooling by the same amount
    const values = years.map((_, i) => [i, -i]);
    const data = makeData(years, [0], [0, 2], values);

    const field = computeField(data, buildPrefixSums(data), options);

    expect(field[0]).toBeCloseTo(6.5, 5);
    expect(field[1]).toBeCloseTo(-6.5, 5);
  });
});

describe("fieldGlobalMean", () => {
  it("weights by cos(latitude)", () => {
    const field = Float32Array.from([0, 2, 0]);
    const lats = [-60, 0, 60];

    const weights = lats.map((lat) => Math.cos((lat * Math.PI) / 180));
    const expected = (2 * weights[1]!) / (weights[0]! + weights[1]! + weights[2]!);

    expect(fieldGlobalMean(field, lats, 1)).toBeCloseTo(expected, 10);
  });

  it("skips missing cells rather than treating them as zero", () => {
    const field = Float32Array.from([1, Number.NaN]);

    expect(fieldGlobalMean(field, [0, 0], 1)).toBeCloseTo(1, 10);
  });

  it("is NaN when nothing is present", () => {
    expect(fieldGlobalMean(Float32Array.from([Number.NaN]), [0], 1)).toBeNaN();
  });
});
