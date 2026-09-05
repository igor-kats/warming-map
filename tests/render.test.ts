import { geoEqualEarth, geoOrthographic } from "d3-geo";
import { describe, expect, it } from "vitest";

import { buildPalette, paletteIndex, MISSING_RGB } from "../src/palette.js";
import {
  assertPseudocylindrical,
  buildLookup,
  createProjection,
  fitProjection,
  OUTSIDE,
  paintField,
  projectionFor,
} from "../src/render.js";

/** The GISTEMP grid: 2 degree cells, centres at -89..89 and -179..179. */
const grid = {
  lats: Array.from({ length: 90 }, (_, i) => -89 + 2 * i),
  lons: Array.from({ length: 180 }, (_, i) => -179 + 2 * i),
  nLats: 90,
  nLons: 180,
};

const WIDTH = 410;
const HEIGHT = 200;

/** The world projection at the test canvas size. */
function worldProjection(width = WIDTH, height = HEIGHT) {
  return fitProjection(createProjection(), width, height);
}

describe("assertPseudocylindrical", () => {
  it("accepts Equal Earth", () => {
    expect(() => assertPseudocylindrical(worldProjection())).not.toThrow();
  });

  it("rejects a projection whose parallels are not rows", () => {
    const orthographic = geoOrthographic().fitSize([WIDTH, HEIGHT], { type: "Sphere" });

    expect(() => assertPseudocylindrical(orthographic)).toThrow(/not pseudocylindrical/);
  });
});

describe("buildLookup", () => {
  const lookup = buildLookup(worldProjection(), WIDTH, HEIGHT, grid);

  it("covers one entry per pixel", () => {
    expect(lookup).toHaveLength(WIDTH * HEIGHT);
  });

  it("marks the corners as off the globe", () => {
    expect(lookup[0]).toBe(OUTSIDE);
    expect(lookup[WIDTH - 1]).toBe(OUTSIDE);
    expect(lookup[WIDTH * HEIGHT - 1]).toBe(OUTSIDE);
  });

  it("puts the centre pixel in an equatorial cell near the prime meridian", () => {
    const centre = lookup[Math.floor(HEIGHT / 2) * WIDTH + Math.floor(WIDTH / 2)]!;
    expect(centre).not.toBe(OUTSIDE);

    const lat = grid.lats[Math.floor(centre / grid.nLons)]!;
    const lon = grid.lons[centre % grid.nLons]!;

    expect(Math.abs(lat)).toBeLessThanOrEqual(2);
    expect(Math.abs(lon)).toBeLessThanOrEqual(2);
  });

  it("keeps every index inside the grid", () => {
    for (const cell of lookup) {
      if (cell === OUTSIDE) continue;
      expect(cell).toBeGreaterThanOrEqual(0);
      expect(cell).toBeLessThan(grid.nLats * grid.nLons);
    }
  });

  it("puts north at the top", () => {
    const column = Math.floor(WIDTH / 2);
    const rowLat = (y: number): number | null => {
      const cell = lookup[y * WIDTH + column]!;
      return cell === OUTSIDE ? null : grid.lats[Math.floor(cell / grid.nLons)]!;
    };

    const north = rowLat(Math.floor(HEIGHT * 0.15));
    const south = rowLat(Math.floor(HEIGHT * 0.85));

    expect(north).not.toBeNull();
    expect(south).not.toBeNull();
    expect(north!).toBeGreaterThan(south!);
  });

  it("puts west on the left", () => {
    const row = Math.floor(HEIGHT / 2);
    const colLon = (x: number): number | null => {
      const cell = lookup[row * WIDTH + x]!;
      return cell === OUTSIDE ? null : grid.lons[cell % grid.nLons]!;
    };

    expect(colLon(Math.floor(WIDTH * 0.2))!).toBeLessThan(colLon(Math.floor(WIDTH * 0.8))!);
  });

  it("agrees with a per-pixel inverse, which is the slow reference", () => {
    const projection = worldProjection();
    const invert = projection.invert!;
    let checked = 0;

    for (let y = 3; y < HEIGHT; y += 17) {
      for (let x = 3; x < WIDTH; x += 17) {
        const cell = lookup[y * WIDTH + x]!;
        if (cell === OUTSIDE) continue;

        const [lon, lat] = invert([x + 0.5, y + 0.5])!;
        const expected =
          Math.min(89, Math.max(0, Math.floor((lat + 90) / 2))) * grid.nLons +
          Math.min(179, Math.max(0, Math.floor((lon + 180) / 2)));

        expect(cell).toBe(expected);
        checked++;
      }
    }

    expect(checked).toBeGreaterThan(100);
  });

  it("refuses a grid it cannot infer a step from", () => {
    expect(() =>
      buildLookup(worldProjection(), 4, 4, { lats: [0], lons: [0], nLats: 1, nLons: 1 }),
    ).toThrow(/at least two/);
  });
});

describe("palette", () => {
  const lut = buildPalette();

  it("runs blue at the cold end to red at the warm end", () => {
    const cold = paletteIndex(-2, 2) * 3;
    const warm = paletteIndex(2, 2) * 3;

    expect(lut[cold + 2]!).toBeGreaterThan(lut[cold]!); // blue dominant
    expect(lut[warm]!).toBeGreaterThan(lut[warm + 2]!); // red dominant
  });

  it("is symmetric about zero", () => {
    const steps = lut.length / 3;

    expect(paletteIndex(-1, 2, steps) + paletteIndex(1, 2, steps)).toBe(steps - 1);
  });

  it("saturates beyond the limit instead of wrapping", () => {
    const steps = lut.length / 3;

    expect(paletteIndex(9, 2, steps)).toBe(steps - 1);
    expect(paletteIndex(-9, 2, steps)).toBe(0);
  });

  it("keeps the missing grey darker than the ramp's centre", () => {
    const centre = paletteIndex(0, 2) * 3;

    expect(MISSING_RGB[0]).toBeLessThan(lut[centre]! - 40);
  });
});

describe("paintField", () => {
  const lut = buildPalette();

  function paint(field: Float32Array, lookup: Int32Array) {
    const image = { data: new Uint8ClampedArray(lookup.length * 4) } as ImageData;
    paintField(image, field, lookup, lut, 2);
    return image.data;
  }

  it("leaves off-globe pixels transparent", () => {
    const pixels = paint(Float32Array.from([1]), Int32Array.from([OUTSIDE]));

    expect(pixels[3]).toBe(0);
  });

  it("paints missing cells the missing grey, opaque", () => {
    const pixels = paint(Float32Array.from([Number.NaN]), Int32Array.from([0]));

    expect([pixels[0], pixels[1], pixels[2]]).toEqual([...MISSING_RGB]);
    expect(pixels[3]).toBe(255);
  });

  it("paints warming red and cooling blue", () => {
    const pixels = paint(Float32Array.from([2, -2]), Int32Array.from([0, 1]));

    expect(pixels[0]!).toBeGreaterThan(pixels[2]!); // cell 0 warm -> red
    expect(pixels[6]!).toBeGreaterThan(pixels[4]!); // cell 1 cold -> blue
  });

  it("gives the same colour to values beyond the limit", () => {
    const pixels = paint(Float32Array.from([2, 40]), Int32Array.from([0, 1]));

    expect([pixels[0], pixels[1], pixels[2]]).toEqual([pixels[4], pixels[5], pixels[6]]);
  });
});

describe("fitProjection", () => {
  it("fits Equal Earth inside the requested box", () => {
    const projection = fitProjection(geoEqualEarth(), 800, 400);

    for (const point of [
      [0, 0],
      [-179, 0],
      [179, 0],
      [0, 89],
      [0, -89],
    ] as const) {
      const xy = projection([point[0], point[1]])!;
      expect(xy[0]).toBeGreaterThanOrEqual(-0.5);
      expect(xy[0]).toBeLessThanOrEqual(800.5);
      expect(xy[1]).toBeGreaterThanOrEqual(-0.5);
      expect(xy[1]).toBeLessThanOrEqual(400.5);
    }
  });
});

describe("regions", () => {
  const W = 800;
  const H = 400;
  const inside = (xy: [number, number] | null): boolean =>
    xy !== null && xy[0] >= 0 && xy[0] <= W && xy[1] >= 0 && xy[1] <= H;

  const LONDON: [number, number] = [-0.13, 51.5];
  const CHICAGO: [number, number] = [-87.6, 41.9];
  const SYDNEY: [number, number] = [151.2, -33.9];

  it("shows the whole world in the world view", () => {
    const projection = projectionFor("world", W, H);

    for (const place of [LONDON, CHICAGO, SYDNEY]) {
      expect(inside(projection(place))).toBe(true);
    }
  });

  it("frames Europe and leaves the rest of the world off-canvas", () => {
    const projection = projectionFor("eu", W, H);

    expect(inside(projection(LONDON))).toBe(true);
    expect(inside(projection(SYDNEY))).toBe(false);
    expect(inside(projection(CHICAGO))).toBe(false);
  });

  it("frames North America and leaves the rest of the world off-canvas", () => {
    const projection = projectionFor("na", W, H);

    expect(inside(projection(CHICAGO))).toBe(true);
    expect(inside(projection(LONDON))).toBe(false);
    expect(inside(projection(SYDNEY))).toBe(false);
  });

  it("magnifies: a degree of longitude is bigger zoomed in than on the world map", () => {
    const world = projectionFor("world", W, H);
    const europe = projectionFor("eu", W, H);
    const span = (p: ReturnType<typeof projectionFor>) => p([10, 50])![0] - p([9, 50])![0];

    expect(span(europe)).toBeGreaterThan(span(world) * 3);
  });

  it("keeps the row-wise lookup valid for the zoomed projections", () => {
    for (const region of ["eu", "na"] as const) {
      expect(() => assertPseudocylindrical(projectionFor(region, W, H))).not.toThrow();
    }
  });
});
