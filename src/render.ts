/**
 * Painting the anomaly field onto a canvas.
 *
 * Each frame is one ImageData the size of the canvas, filled through a
 * pixel -> cell lookup that is built once per viewport size. Redrawing a year
 * is then a linear pass over the pixels with no projection maths at all.
 *
 * Building that lookup by inverting the projection at every pixel costs about
 * 500 ms for a 3.3 Mpx canvas, which is far too slow to do on resize. Both
 * projections the brief allows (Equal Earth, Natural Earth) are
 * pseudocylindrical: every point on a parallel lands on the same canvas row,
 * and x is exactly linear in longitude along that row. So the lookup inverts
 * once per row instead of once per pixel -- 1.4 ms for the same canvas, and
 * exact rather than approximate. `assertPseudocylindrical` checks the
 * assumption at startup so swapping in, say, an orthographic projection fails
 * loudly instead of drawing a plausible lie.
 */

import {
  geoEqualEarth,
  geoEquirectangular,
  geoPath,
  type GeoPermissibleObjects,
  type GeoProjection,
} from "d3-geo";

import type { Region } from "./url.js";

import { BACKGROUND_RGB, MISSING_RGB, paletteIndex } from "./palette.js";

/** Lookup entry for a pixel that is not on the globe. */
export const OUTSIDE = -1;

export interface CellGrid {
  readonly lats: readonly number[];
  readonly lons: readonly number[];
  readonly nLats: number;
  readonly nLons: number;
}

/** Kept just inside +/-180 so d3's antimeridian clipping does not wrap the edge. */
const LON_EDGE = 180 - 1e-6;

export function createProjection(): GeoProjection {
  return geoEqualEarth();
}

/**
 * What each region frames. The world gets Equal Earth, which is equal-area, so
 * no part of the map is given more visual weight than its size on the ground.
 * The two zooms get equirectangular, per the brief: over a continent the
 * distortion is small and the straight graticule keeps latitudes comparable.
 * Both families are pseudocylindrical, so the row-wise lookup holds for either.
 */
export const REGION_BOUNDS: Readonly<Record<Region, readonly [number, number, number, number] | null>> =
  {
    world: null,
    eu: [-25, 33, 45, 72],
    na: [-170, 13, -52, 74],
  };

/**
 * The area a region should fill, as something fitExtent understands.
 *
 * The corners are given as a MultiPoint rather than a Polygon on purpose.
 * d3-geo reads polygons spherically, so a ring wound the wrong way means the
 * whole rest of the planet, and `fitExtent` then quietly fits the world instead
 * of the region — a bug that looks like "the zoom does nothing". Points carry
 * no winding, and for the equirectangular zooms a lat/lon rectangle's corners
 * bound exactly the rectangle on screen.
 */
function regionExtent(region: Region): GeoPermissibleObjects {
  const bounds = REGION_BOUNDS[region];
  if (!bounds) return { type: "Sphere" } as GeoPermissibleObjects;

  const [west, south, east, north] = bounds;
  return {
    type: "MultiPoint",
    coordinates: [
      [west, south],
      [east, south],
      [east, north],
      [west, north],
    ],
  } as GeoPermissibleObjects;
}

/** A projection for `region`, already fitted to a canvas of this size. */
export function projectionFor(region: Region, width: number, height: number): GeoProjection {
  const projection = region === "world" ? geoEqualEarth() : geoEquirectangular();
  return fitProjection(projection, width, height, regionExtent(region));
}

/** Fit the projection so `extent` fills a canvas of this size. */
export function fitProjection(
  projection: GeoProjection,
  width: number,
  height: number,
  extent: GeoPermissibleObjects = { type: "Sphere" } as GeoPermissibleObjects,
): GeoProjection {
  return projection.fitExtent(
    [
      [0, 0],
      [width, height],
    ],
    extent,
  );
}

/**
 * Throw unless the projection maps parallels to rows and longitude linearly to x.
 * Tolerances are in canvas pixels.
 */
export function assertPseudocylindrical(projection: GeoProjection, tolerance = 1e-3): void {
  for (const lat of [-80, -40, 0, 40, 80]) {
    const left = projection([-LON_EDGE, lat]);
    const right = projection([LON_EDGE, lat]);
    if (!left || !right) throw new Error("projection does not cover the whole sphere");

    for (const lon of [-120, -45, 12, 90, 160]) {
      const exact = projection([lon, lat]);
      if (!exact) throw new Error("projection does not cover the whole sphere");

      const t = (lon + LON_EDGE) / (2 * LON_EDGE);
      const linear = left[0] + t * (right[0] - left[0]);
      if (Math.abs(exact[0] - linear) > tolerance || Math.abs(exact[1] - left[1]) > tolerance) {
        throw new Error(
          "projection is not pseudocylindrical; the row-wise pixel lookup would be wrong",
        );
      }
    }
  }
}

/**
 * Map every pixel of a `width` x `height` canvas to a flat cell index, or OUTSIDE.
 * Pixel centres are sampled, so a cell's colour covers the pixels whose centres
 * fall inside it — nearest-neighbour, which is what a 2 degree grid deserves.
 */
export function buildLookup(
  projection: GeoProjection,
  width: number,
  height: number,
  grid: CellGrid,
): Int32Array {
  const invert = projection.invert;
  if (!invert) throw new Error("projection has no inverse");

  const lookup = new Int32Array(width * height).fill(OUTSIDE);
  const { lats, lons, nLats, nLons } = grid;

  // Cell coordinates are centres; the cell spans half a step either side.
  const dLat = (lats[1] ?? 0) - (lats[0] ?? 0);
  const dLon = (lons[1] ?? 0) - (lons[0] ?? 0);
  if (dLat === 0 || dLon === 0) throw new Error("grid needs at least two lats and two lons");
  const latOrigin = lats[0]! - dLat / 2;
  const lonOrigin = lons[0]! - dLon / 2;

  const centreX = width / 2;

  for (let y = 0; y < height; y++) {
    const py = y + 0.5;

    const inverted = invert([centreX, py]);
    if (!inverted) continue;
    const lat = inverted[1];
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) continue;

    // invert() answers even for pixels off the map, so confirm the round trip.
    const back = projection([0, lat]);
    if (!back || Math.abs(back[1] - py) > 0.5) continue;

    const left = projection([-LON_EDGE, lat]);
    const right = projection([LON_EDGE, lat]);
    if (!left || !right || !(right[0] > left[0])) continue;

    let latIndex = Math.floor((lat - latOrigin) / dLat);
    if (latIndex < 0) latIndex = 0;
    else if (latIndex >= nLats) latIndex = nLats - 1;

    const xLeft = left[0];
    const span = right[0] - xLeft;
    const rowBase = y * width;
    const cellRow = latIndex * nLons;

    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      if (px < xLeft || px > right[0]) continue;

      const lon = -LON_EDGE + ((px - xLeft) / span) * (2 * LON_EDGE);
      let lonIndex = Math.floor((lon - lonOrigin) / dLon);
      if (lonIndex < 0) lonIndex = 0;
      else if (lonIndex >= nLons) lonIndex = nLons - 1;

      lookup[rowBase + x] = cellRow + lonIndex;
    }
  }

  return lookup;
}

/**
 * Fill `target` from the field. Cells with no data take the missing grey;
 * pixels off the globe are left transparent so the page background shows.
 */
export function paintField(
  target: ImageData,
  field: Float32Array,
  lookup: Int32Array,
  lut: Uint8ClampedArray,
  limit: number,
): void {
  const pixels = target.data;
  const steps = lut.length / 3;

  for (let i = 0; i < lookup.length; i++) {
    const offset = i * 4;
    const cell = lookup[i]!;

    if (cell === OUTSIDE) {
      pixels[offset] = BACKGROUND_RGB[0];
      pixels[offset + 1] = BACKGROUND_RGB[1];
      pixels[offset + 2] = BACKGROUND_RGB[2];
      pixels[offset + 3] = 0;
      continue;
    }

    const value = field[cell]!;
    if (Number.isNaN(value)) {
      pixels[offset] = MISSING_RGB[0];
      pixels[offset + 1] = MISSING_RGB[1];
      pixels[offset + 2] = MISSING_RGB[2];
    } else {
      const j = paletteIndex(value, limit, steps) * 3;
      pixels[offset] = lut[j]!;
      pixels[offset + 1] = lut[j + 1]!;
      pixels[offset + 2] = lut[j + 2]!;
    }
    pixels[offset + 3] = 255;
  }
}

/** Draw coastlines and the globe outline onto the overlay canvas. */
export function drawOutlines(
  ctx: CanvasRenderingContext2D,
  projection: GeoProjection,
  land: GeoPermissibleObjects,
  scale: number,
  withSphere = true,
): void {
  const path = geoPath(projection, ctx);

  ctx.save();
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  ctx.lineJoin = "round";
  ctx.lineWidth = 0.7 * scale;
  ctx.strokeStyle = "rgba(20, 24, 28, 0.55)";
  ctx.beginPath();
  path(land);
  ctx.stroke();

  if (withSphere) {
    ctx.lineWidth = 1 * scale;
    ctx.strokeStyle = "rgba(20, 24, 28, 0.35)";
    ctx.beginPath();
    path({ type: "Sphere" });
    ctx.stroke();
  }

  ctx.restore();
}
