/**
 * Loading and decoding of public/data/gistemp_annual.{bin,json}.
 *
 * The binary is a flat little-endian int16 array laid out [year][lat][lon],
 * where the stored integer is the temperature anomaly in degrees Celsius
 * multiplied by `meta.scale`, and `meta.missing` marks a missing cell-year.
 * Written by scripts/build_gistemp.py.
 */

export interface GistempMeta {
  readonly lats: readonly number[];
  readonly lons: readonly number[];
  readonly years: readonly number[];
  /** [nYears, nLats, nLons] */
  readonly shape: readonly [number, number, number];
  readonly scale: number;
  readonly missing: number;
  readonly baseline: string;
  readonly source: string;
  readonly licence: string;
  readonly built_at: string;
}

export interface GistempData {
  readonly meta: GistempMeta;
  readonly nYears: number;
  readonly nLats: number;
  readonly nLons: number;
  /** Raw quantised values, length nYears * nLats * nLons. */
  readonly values: Int16Array;
}

/** Cells the source has no reading for read back as NaN, never as zero. */
export const MISSING = Number.NaN;

/** Decode the raw bytes against their sidecar, checking that the two agree. */
export function decodeGistemp(meta: GistempMeta, buffer: ArrayBuffer): GistempData {
  const [nYears, nLats, nLons] = meta.shape;
  const expected = nYears * nLats * nLons;

  if (meta.years.length !== nYears || meta.lats.length !== nLats || meta.lons.length !== nLons) {
    throw new Error("gistemp_annual.json: shape disagrees with the coordinate arrays");
  }
  if (buffer.byteLength !== expected * 2) {
    throw new Error(
      `gistemp_annual.bin: expected ${expected * 2} bytes for shape ` +
        `${nYears}x${nLats}x${nLons}, got ${buffer.byteLength}`,
    );
  }

  // Int16Array reads in the platform's byte order, which is little-endian on
  // every architecture browsers ship on; a DataView would be needed otherwise.
  return { meta, nYears, nLats, nLons, values: new Int16Array(buffer) };
}

/** Flat index of a cell-year. */
export function indexOf(data: GistempData, year: number, lat: number, lon: number): number {
  return (year * data.nLats + lat) * data.nLons + lon;
}

/** Anomaly in degrees Celsius for a cell-year, or NaN where the source has no data. */
export function valueAt(data: GistempData, year: number, lat: number, lon: number): number {
  const raw = data.values[indexOf(data, year, lat, lon)];
  if (raw === undefined || raw === data.meta.missing) return MISSING;
  return raw / data.meta.scale;
}

function looksGzipped(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 2) return false;
  const head = new Uint8Array(buffer, 0, 2);
  return head[0] === 0x1f && head[1] === 0x8b;
}

/**
 * Fetch the grid, preferring the pre-compressed copy.
 *
 * The binary is a third of its size gzipped, but a static host will not
 * necessarily compress `application/octet-stream` on the way out, so the build
 * ships a `.bin.gz` and the page inflates it itself. Two things can go wrong
 * and both are handled: a browser without `DecompressionStream`, which falls
 * back to the plain `.bin`; and a host that serves the `.gz` with
 * `Content-Encoding: gzip`, where the browser has already inflated it before we
 * see it. Hence the magic-number check rather than inflating on faith.
 */
async function fetchGrid(prefix: string): Promise<ArrayBuffer> {
  if (typeof DecompressionStream === "function") {
    const response = await fetch(`${prefix}.bin.gz`);
    if (response.ok) {
      const payload = await response.arrayBuffer();
      if (!looksGzipped(payload)) return payload; // the host inflated it for us
      const stream = new Blob([payload]).stream().pipeThrough(new DecompressionStream("gzip"));
      return await new Response(stream).arrayBuffer();
    }
  }

  const response = await fetch(`${prefix}.bin`);
  if (!response.ok) throw new Error(`${prefix}.bin: HTTP ${response.status}`);
  return await response.arrayBuffer();
}

/** Fetch both files. `base` is the site base path, e.g. Vite's BASE_URL. */
export async function loadGistemp(base = "/"): Promise<GistempData> {
  const prefix = `${base.replace(/\/$/, "")}/data/gistemp_annual`;
  const [metaResponse, grid] = await Promise.all([fetch(`${prefix}.json`), fetchGrid(prefix)]);
  if (!metaResponse.ok) throw new Error(`${prefix}.json: HTTP ${metaResponse.status}`);

  const meta = (await metaResponse.json()) as GistempMeta;
  return decodeGistemp(meta, grid);
}
