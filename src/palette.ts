/**
 * The diverging colour ramp, baked into a lookup table once.
 *
 * RdBu reversed: blue where a cell has cooled, near-white where it has not
 * changed, red where it has warmed. It is symmetric around zero, so the colour
 * at -1 °C is the mirror of the colour at +1 °C and the eye is not told that
 * warming and cooling are different sizes.
 *
 * Missing cells get a flat mid-grey that is darker than anything in the ramp,
 * so "no data" cannot be mistaken for "no change".
 */

import { interpolateRdBu } from "d3-scale-chromatic";

export const LUT_STEPS = 512;

/** Mid-grey for cells the source has no reading for. Darker than the ramp's centre. */
export const MISSING_RGB: readonly [number, number, number] = [138, 141, 145];

/** Colour behind the map, outside the globe. */
export const BACKGROUND_RGB: readonly [number, number, number] = [255, 255, 255];

const RGB_PATTERN = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/;

function parseRgb(css: string): [number, number, number] {
  const match = RGB_PATTERN.exec(css);
  if (!match) throw new Error(`unexpected colour from d3: ${css}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Sample the ramp into `steps` RGB triples, index 0 = coldest, last = warmest.
 * d3's RdBu runs red -> blue, so the sample position is inverted.
 */
export function buildPalette(steps = LUT_STEPS): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(steps * 3);
  for (let i = 0; i < steps; i++) {
    const t = steps === 1 ? 0.5 : i / (steps - 1);
    const [r, g, b] = parseRgb(interpolateRdBu(1 - t));
    lut[i * 3] = r;
    lut[i * 3 + 1] = g;
    lut[i * 3 + 2] = b;
  }
  return lut;
}

/**
 * Palette index for an anomaly, clamped to +/- `limit`.
 * Values beyond the limit saturate rather than wrap, so an extreme cell stays
 * the extreme colour instead of reappearing at the other end of the ramp.
 */
export function paletteIndex(value: number, limit: number, steps = LUT_STEPS): number {
  const t = (value + limit) / (2 * limit);
  const index = Math.round(t * (steps - 1));
  return index < 0 ? 0 : index > steps - 1 ? steps - 1 : index;
}

/** CSS colour for an anomaly, for the legend and any non-canvas use. */
export function cssFor(value: number, limit: number, lut: Uint8ClampedArray): string {
  const i = paletteIndex(value, limit, lut.length / 3) * 3;
  return `rgb(${lut[i]}, ${lut[i + 1]}, ${lut[i + 2]})`;
}
