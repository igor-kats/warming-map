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

/** Fetch both files. `base` is the site base path, e.g. Vite's BASE_URL. */
export async function loadGistemp(base = "/"): Promise<GistempData> {
  const prefix = `${base.replace(/\/$/, "")}/data/gistemp_annual`;
  const [metaResponse, binResponse] = await Promise.all([
    fetch(`${prefix}.json`),
    fetch(`${prefix}.bin`),
  ]);
  if (!metaResponse.ok) throw new Error(`${prefix}.json: HTTP ${metaResponse.status}`);
  if (!binResponse.ok) throw new Error(`${prefix}.bin: HTTP ${binResponse.status}`);

  const meta = (await metaResponse.json()) as GistempMeta;
  return decodeGistemp(meta, await binResponse.arrayBuffer());
}
