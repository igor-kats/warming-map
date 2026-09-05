/**
 * The diverging colour ramps, baked into lookup tables once.
 *
 * Both run cool -> neutral -> warm and are symmetric around zero, so the colour
 * at -1 °C mirrors the colour at +1 °C and the eye is not told that warming and
 * cooling are different sizes.
 *
 * RdBu is the default and the one people expect for temperature. PuOr is the
 * colour-blind-safe alternative: red and blue are the pair deuteranopes and
 * protanopes confuse most readily, whereas purple and orange separate on the
 * blue-yellow axis that stays intact in the common forms of colour blindness.
 *
 * Missing cells get a flat mid-grey darker than either ramp's centre, so
 * "no data" cannot be mistaken for "no change".
 */

import { interpolatePuOr, interpolateRdBu } from "d3-scale-chromatic";

export const LUT_STEPS = 512;

export type PaletteName = "rdbu" | "puor";

export const PALETTE_OPTIONS: readonly PaletteName[] = ["rdbu", "puor"];

export const PALETTE_LABELS: Readonly<Record<PaletteName, string>> = {
  rdbu: "Blue–red",
  puor: "Purple–orange",
};

/** Mid-grey for cells the source has no reading for. Darker than either ramp's centre. */
export const MISSING_RGB: readonly [number, number, number] = [138, 141, 145];

/** Colour behind the map, outside the globe. */
export const BACKGROUND_RGB: readonly [number, number, number] = [255, 255, 255];

/**
 * d3's two ramps run in opposite directions: RdBu is red at t=0 and blue at
 * t=1, while PuOr is purple at t=0 and orange at t=1. Each therefore records
 * which way it has to be sampled to put the cool end at index 0. Taking the
 * direction on faith would silently paint warming purple and cooling orange.
 */
interface Ramp {
  readonly interpolate: (t: number) => string;
  /** True when d3's t=0 is the warm end. */
  readonly warmFirst: boolean;
}

const RAMPS: Readonly<Record<PaletteName, Ramp>> = {
  rdbu: { interpolate: interpolateRdBu, warmFirst: true },
  puor: { interpolate: interpolatePuOr, warmFirst: false },
};

const RGB_PATTERN = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/;

function parseRgb(css: string): [number, number, number] {
  const match = RGB_PATTERN.exec(css);
  if (!match) throw new Error(`unexpected colour from d3: ${css}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Sample a ramp into `steps` RGB triples, index 0 = coolest, last = warmest. */
export function buildPalette(name: PaletteName = "rdbu", steps = LUT_STEPS): Uint8ClampedArray {
  const ramp = RAMPS[name];
  const lut = new Uint8ClampedArray(steps * 3);

  for (let i = 0; i < steps; i++) {
    const position = steps === 1 ? 0.5 : i / (steps - 1);
    const t = ramp.warmFirst ? 1 - position : position;
    const [r, g, b] = parseRgb(ramp.interpolate(t));
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
