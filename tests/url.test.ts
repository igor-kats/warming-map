import { describe, expect, it } from "vitest";

import { PALETTE_OPTIONS } from "../src/palette.js";
import {
  BASELINE_PRESETS,
  DEFAULTS,
  LIMIT_OPTIONS,
  REGION_OPTIONS,
  WINDOW_OPTIONS,
  clampYear,
  defaultState,
  firstPlayableYear,
  nextYear,
  parseHash,
  serialiseHash,
  type RecordLimits,
  type ViewState,
} from "../src/url.js";

/** The shape of the real record: 1880 to 2025. */
const limits: RecordLimits = { firstYear: 1880, lastYear: 2025 };

const defaults = defaultState(limits);

describe("defaults", () => {
  it("are the brief's default view", () => {
    expect(defaults).toEqual({
      baselineStart: 1951,
      baselineEnd: 1980,
      windowYears: 5,
      year: 2024,
      region: "world",
      limit: 2,
      palette: "rdbu",
    });
  });

  it("pull the year inside a short record", () => {
    expect(defaultState({ firstYear: 1880, lastYear: 1990 }).year).toBe(1990);
  });
});

describe("serialiseHash", () => {
  it("writes the documented shape", () => {
    const state: ViewState = {
      baselineStart: 1951,
      baselineEnd: 1980,
      windowYears: 5,
      year: 2016,
      region: "eu",
      limit: 2,
      palette: "rdbu",
    };

    expect(serialiseHash(state)).toBe("#b=1951-1980&w=5&y=2016&r=eu&p=2&c=rdbu");
  });
});

describe("round trip", () => {
  it("restores the documented example", () => {
    const parsed = parseHash("#b=1951-1980&w=5&y=2016&r=eu&p=2", limits);

    expect(parsed).toEqual({
      baselineStart: 1951,
      baselineEnd: 1980,
      windowYears: 5,
      year: 2016,
      region: "eu",
      limit: 2,
      palette: "rdbu", // an older link without `c` still opens
    });
  });

  it("survives every combination of the offered options", () => {
    let checked = 0;

    for (const [baselineStart, baselineEnd] of BASELINE_PRESETS) {
      for (const windowYears of WINDOW_OPTIONS) {
        for (const region of REGION_OPTIONS) {
          for (const limit of LIMIT_OPTIONS) {
            for (const year of [1900, 1980, 2016, 2025]) {
              for (const palette of PALETTE_OPTIONS) {
                const state: ViewState = {
                  baselineStart,
                  baselineEnd,
                  windowYears,
                  year,
                  region,
                  limit,
                  palette,
                };

                expect(parseHash(serialiseHash(state), limits)).toEqual(state);
                checked++;
              }
            }
          }
        }
      }
    }

    expect(checked).toBe(3 * 3 * 3 * 4 * 4 * 2);
  });

  it("accepts a hash with or without the leading #", () => {
    const withHash = parseHash("#b=1880-1910&w=10&y=1950&r=na&p=4", limits);
    const without = parseHash("b=1880-1910&w=10&y=1950&r=na&p=4", limits);

    expect(without).toEqual(withHash);
  });
});

describe("invalid input falls back silently", () => {
  it("takes every default from an empty hash", () => {
    expect(parseHash("", limits)).toEqual(defaults);
    expect(parseHash("#", limits)).toEqual(defaults);
  });

  it("ignores junk", () => {
    expect(parseHash("#nonsense&&=&b", limits)).toEqual(defaults);
  });

  it.each([
    ["w=7", "windowYears"],
    ["w=abc", "windowYears"],
    ["w=", "windowYears"],
    ["p=0", "limit"],
    ["p=9", "limit"],
    ["r=mars", "region"],
    ["b=1980-1951", "baselineStart"],
    ["b=1800-1900", "baselineStart"],
    ["b=1951-2999", "baselineStart"],
    ["b=nope", "baselineStart"],
    ["y=nineteen", "year"],
    ["c=viridis", "palette"],
    ["c=", "palette"],
  ])("rejects %s", (fragment) => {
    expect(parseHash(`#${fragment}`, limits)).toEqual(defaults);
  });

  it("keeps the good fields when one is bad", () => {
    const parsed = parseHash("#b=1991-2020&w=99&y=2001&r=na&p=3", limits);

    expect(parsed.baselineStart).toBe(1991);
    expect(parsed.baselineEnd).toBe(2020);
    expect(parsed.region).toBe("na");
    expect(parsed.limit).toBe(3);
    expect(parsed.year).toBe(2001);
    expect(parsed.windowYears).toBe(DEFAULTS.windowYears); // only this one falls back
  });

  it("clamps a year outside the record instead of discarding it", () => {
    expect(parseHash("#y=2999", limits).year).toBe(2025);
    expect(parseHash("#y=1800", limits).year).toBe(1884); // 5-year window floor
  });

  it("clamps the year against the window that came with it", () => {
    expect(parseHash("#w=10&y=1881", limits).year).toBe(1889);
    expect(parseHash("#w=1&y=1881", limits).year).toBe(1881);
  });
});

describe("the playable range", () => {
  it("starts where a window can first be filled", () => {
    expect(firstPlayableYear(limits, 1)).toBe(1880);
    expect(firstPlayableYear(limits, 5)).toBe(1884);
    expect(firstPlayableYear(limits, 10)).toBe(1889);
  });

  it("never runs past the end of a short record", () => {
    expect(firstPlayableYear({ firstYear: 1880, lastYear: 1883 }, 10)).toBe(1883);
  });

  it("clamps both ends", () => {
    expect(clampYear(1800, limits, 5)).toBe(1884);
    expect(clampYear(2999, limits, 5)).toBe(2025);
    expect(clampYear(1950, limits, 5)).toBe(1950);
  });
});

describe("play loop bounds", () => {
  it("advances one year at a time", () => {
    expect(nextYear(1950, limits, 5)).toBe(1951);
  });

  it("wraps from the last year back to the first playable one", () => {
    expect(nextYear(2025, limits, 5)).toBe(1884);
    expect(nextYear(2025, limits, 10)).toBe(1889);
    expect(nextYear(2025, limits, 1)).toBe(1880);
  });

  it("jumps forward when the year sits below the window's floor", () => {
    expect(nextYear(1881, limits, 10)).toBe(1889);
  });

  it("wraps rather than exceeding the record if the year is already past it", () => {
    expect(nextYear(2999, limits, 5)).toBe(1884);
  });

  it("stays inside the record over a full lap", () => {
    const floor = firstPlayableYear(limits, 5);
    let year = floor;
    const seen = new Set<number>();

    for (let step = 0; step < 500; step++) {
      year = nextYear(year, limits, 5);
      expect(year).toBeGreaterThanOrEqual(floor);
      expect(year).toBeLessThanOrEqual(limits.lastYear);
      seen.add(year);
    }

    // A lap is 142 years, so 500 steps must have covered every one of them.
    expect(seen.size).toBe(limits.lastYear - floor + 1);
  });

  it("does not stall on a single-year record", () => {
    const tiny: RecordLimits = { firstYear: 2000, lastYear: 2000 };

    expect(nextYear(2000, tiny, 5)).toBe(2000);
  });
});
