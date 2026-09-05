/**
 * The view state, and the URL hash it round-trips through.
 *
 * Everything that changes what the map shows lives in one plain object, so a
 * view can be shared as a link and restored exactly. Playback (playing, speed)
 * is deliberately not in the hash: it is how you are looking, not what you are
 * looking at, and a shared link should not start animating at 4x on arrival.
 *
 * Parsing never throws and never warns. A hash someone edited by hand, or one
 * left over from an older build, falls back field by field to the defaults —
 * a bad `w` does not cost you a good `y`.
 */

export type Region = "world" | "eu" | "na";
export type WindowYears = 1 | 5 | 10;
export type PaletteLimit = 1 | 2 | 3 | 4;

export interface ViewState {
  readonly baselineStart: number;
  readonly baselineEnd: number;
  readonly windowYears: WindowYears;
  readonly year: number;
  readonly region: Region;
  readonly limit: PaletteLimit;
}

/** The span of years the data file actually covers. */
export interface RecordLimits {
  readonly firstYear: number;
  readonly lastYear: number;
}

export const BASELINE_PRESETS: readonly (readonly [number, number])[] = [
  [1880, 1910],
  [1951, 1980],
  [1991, 2020],
];

export const WINDOW_OPTIONS: readonly WindowYears[] = [1, 5, 10];
export const LIMIT_OPTIONS: readonly PaletteLimit[] = [1, 2, 3, 4];
export const REGION_OPTIONS: readonly Region[] = ["world", "eu", "na"];
export const SPEED_OPTIONS: readonly number[] = [1, 2, 4];

export const REGION_LABELS: Readonly<Record<Region, string>> = {
  world: "World",
  eu: "Europe",
  na: "North America",
};

/** The brief's default view. The year is pinned rather than tracking the record's end. */
export const DEFAULTS = {
  baselineStart: 1951,
  baselineEnd: 1980,
  windowYears: 5,
  year: 2024,
  region: "world",
  limit: 2,
} as const satisfies ViewState;

/**
 * The earliest year a window can end on and still be fully inside the record.
 * A 5-year window ending in 1880 would be 20% covered, so every cell would be
 * missing and the map would be blank; the slider simply does not go there.
 */
export function firstPlayableYear(limits: RecordLimits, windowYears: WindowYears): number {
  return Math.min(limits.firstYear + windowYears - 1, limits.lastYear);
}

export function clampYear(year: number, limits: RecordLimits, windowYears: WindowYears): number {
  const first = firstPlayableYear(limits, windowYears);
  return year < first ? first : year > limits.lastYear ? limits.lastYear : year;
}

/** The next year of playback, wrapping back to the start of the playable range. */
export function nextYear(year: number, limits: RecordLimits, windowYears: WindowYears): number {
  const first = firstPlayableYear(limits, windowYears);
  if (year < first || year >= limits.lastYear) return first;
  return year + 1;
}

export function defaultState(limits: RecordLimits): ViewState {
  return { ...DEFAULTS, year: clampYear(DEFAULTS.year, limits, DEFAULTS.windowYears) };
}

function isOneOf<T>(options: readonly T[], value: unknown): value is T {
  return options.includes(value as T);
}

function parseBaseline(
  raw: string | null,
  limits: RecordLimits,
): { start: number; end: number } | null {
  const match = /^(-?\d{1,4})-(-?\d{1,4})$/.exec(raw ?? "");
  if (!match) return null;

  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start > end) return null;
  if (start < limits.firstYear || end > limits.lastYear) return null;
  return { start, end };
}

/** Read a view out of a location hash. Unreadable fields silently take their default. */
export function parseHash(hash: string, limits: RecordLimits): ViewState {
  const fallback = defaultState(limits);
  const params = new URLSearchParams(hash.replace(/^#/, ""));

  const baseline = parseBaseline(params.get("b"), limits);

  const rawWindow = Number(params.get("w"));
  const windowYears: WindowYears = isOneOf(WINDOW_OPTIONS, rawWindow)
    ? rawWindow
    : fallback.windowYears;

  const rawLimit = Number(params.get("p"));
  const limit: PaletteLimit = isOneOf(LIMIT_OPTIONS, rawLimit) ? rawLimit : fallback.limit;

  const rawRegion = params.get("r");
  const region: Region = isOneOf(REGION_OPTIONS, rawRegion) ? rawRegion : fallback.region;

  const rawYear = params.get("y");
  const year = /^-?\d{1,4}$/.test(rawYear ?? "") ? Number(rawYear) : fallback.year;

  return {
    baselineStart: baseline?.start ?? fallback.baselineStart,
    baselineEnd: baseline?.end ?? fallback.baselineEnd,
    windowYears,
    year: clampYear(year, limits, windowYears),
    region,
    limit,
  };
}

/** The hash for a view, including the leading '#'. Field order is stable. */
export function serialiseHash(state: ViewState): string {
  const params = new URLSearchParams([
    ["b", `${state.baselineStart}-${state.baselineEnd}`],
    ["w", String(state.windowYears)],
    ["y", String(state.year)],
    ["r", state.region],
    ["p", String(state.limit)],
  ]);
  return `#${params.toString()}`;
}
