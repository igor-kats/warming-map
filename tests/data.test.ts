import { describe, expect, it } from "vitest";

import { decodeGistemp, indexOf, valueAt, type GistempMeta } from "../src/data.js";

const meta: GistempMeta = {
  lats: [-45, 0, 45],
  lons: [-90, 90],
  years: [2000, 2001],
  shape: [2, 3, 2],
  scale: 100,
  missing: -32768,
  baseline: "1951-1980",
  source: "test",
  licence: "test",
  built_at: "2026-09-05",
};

function bytesFor(values: readonly number[]): ArrayBuffer {
  return Int16Array.from(values).buffer;
}

const ramp = Array.from({ length: 12 }, (_, i) => i * 10);

describe("decodeGistemp", () => {
  it("accepts bytes that match the declared shape", () => {
    const data = decodeGistemp(meta, bytesFor(ramp));

    expect([data.nYears, data.nLats, data.nLons]).toEqual([2, 3, 2]);
    expect(data.values).toHaveLength(12);
  });

  it("rejects a buffer of the wrong length", () => {
    expect(() => decodeGistemp(meta, bytesFor([1, 2, 3]))).toThrow(/expected 24 bytes/);
  });

  it("rejects a sidecar whose shape disagrees with its coordinates", () => {
    const broken: GistempMeta = { ...meta, shape: [2, 4, 2] };

    expect(() => decodeGistemp(broken, bytesFor(new Array(16).fill(0)))).toThrow(
      /shape disagrees/,
    );
  });
});

describe("cell lookup", () => {
  const data = decodeGistemp(meta, bytesFor(ramp));

  it("addresses [year][lat][lon] in that order", () => {
    expect(indexOf(data, 0, 0, 0)).toBe(0);
    expect(indexOf(data, 0, 0, 1)).toBe(1);
    expect(indexOf(data, 0, 1, 0)).toBe(2);
    expect(indexOf(data, 1, 0, 0)).toBe(6);
  });

  it("divides the stored integer by the scale", () => {
    expect(valueAt(data, 0, 1, 0)).toBeCloseTo(0.2);
    expect(valueAt(data, 1, 2, 1)).toBeCloseTo(1.1);
  });

  it("reads the missing sentinel back as NaN, not as zero", () => {
    const withHole = decodeGistemp(meta, bytesFor([meta.missing, ...ramp.slice(1)]));

    expect(valueAt(withHole, 0, 0, 0)).toBeNaN();
  });

  it("returns NaN outside the grid", () => {
    expect(valueAt(data, 9, 0, 0)).toBeNaN();
  });
});
