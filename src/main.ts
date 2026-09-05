/**
 * Step 3: controls, client-side recompute and URL state.
 *
 * Work is split by what actually changed. The lookup and the coastlines depend
 * only on the canvas size and the region, so they survive a year change; a year,
 * baseline, window or scale change costs one field recompute and one repaint.
 */

import type { GeoPermissibleObjects } from "d3-geo";
import { feature } from "topojson-client";

import { mountControls, Player } from "./controls.js";
import { buildPrefixSums, computeField, fieldGlobalMean, DEFAULT_MIN_COVERAGE } from "./compute.js";
import { loadGistemp } from "./data.js";
import { buildPalette, MISSING_RGB } from "./palette.js";
import {
  assertPseudocylindrical,
  buildLookup,
  drawOutlines,
  paintField,
  projectionFor,
} from "./render.js";
import {
  clampYear,
  nextYear,
  parseHash,
  serialiseHash,
  type RecordLimits,
  type ViewState,
} from "./url.js";
import "./style.css";

/** Above this the lookup and the ImageData cost more than the sharpness is worth. */
const MAX_DPR = 2;

/** Milliseconds per year at 1x. 4x lands at 25 ms, past what a repaint costs. */
const PLAY_INTERVAL = 100;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found as T;
}

function formatSigned(value: number): string {
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}`;
}

/** Described structurally; topojson-client does the real decoding. */
interface LandTopology {
  readonly objects: { readonly land: unknown };
}

async function loadLand(base: string): Promise<GeoPermissibleObjects> {
  const url = `${base.replace(/\/$/, "")}/geo/land-110m.json`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);

  const topology = (await response.json()) as LandTopology;
  return feature(
    topology as never,
    topology.objects.land as never,
  ) as unknown as GeoPermissibleObjects;
}

function renderLegend(host: HTMLElement, lut: Uint8ClampedArray, limit: number): void {
  const steps = lut.length / 3;
  const stops: string[] = [];
  for (let i = 0; i <= 20; i++) {
    const j = Math.round((i / 20) * (steps - 1)) * 3;
    stops.push(`rgb(${lut[j]}, ${lut[j + 1]}, ${lut[j + 2]}) ${(i / 20) * 100}%`);
  }

  host.replaceChildren();

  const bar = document.createElement("div");
  bar.className = "ramp-bar";
  bar.style.background = `linear-gradient(to right, ${stops.join(", ")})`;
  bar.setAttribute("role", "img");
  bar.setAttribute(
    "aria-label",
    `Colour scale from ${limit} degrees Celsius cooler, through no change, to ${limit} degrees warmer`,
  );

  const ticks = document.createElement("div");
  ticks.className = "ramp-ticks";
  for (const value of [-limit, -limit / 2, 0, limit / 2, limit]) {
    const tick = document.createElement("span");
    tick.textContent = value === 0 ? "0" : `${formatSigned(value).replace(/\.00$/, "")} °C`;
    ticks.append(tick);
  }

  const ramp = document.createElement("div");
  ramp.className = "ramp";
  ramp.append(bar, ticks);

  const chip = document.createElement("i");
  chip.style.background = `rgb(${MISSING_RGB[0]}, ${MISSING_RGB[1]}, ${MISSING_RGB[2]})`;

  const missing = document.createElement("span");
  missing.className = "swatch";
  missing.append(chip, document.createTextNode("no data"));

  host.append(ramp, missing);
}

function describe(state: ViewState, mean: number): string {
  const from = state.year - state.windowYears + 1;
  const window =
    state.windowYears === 1 ? `${state.year}` : `mean of ${from}–${state.year}`;
  return (
    `${state.year} — ${window} vs ${state.baselineStart}–${state.baselineEnd}. ` +
    `Global average ${formatSigned(mean)} °C.`
  );
}

async function start(): Promise<void> {
  const base = import.meta.env.BASE_URL;
  const [data, land] = await Promise.all([loadGistemp(base), loadLand(base)]);

  const prefix = buildPrefixSums(data);
  const lut = buildPalette();
  const limits: RecordLimits = {
    firstYear: data.meta.years[0] ?? 0,
    lastYear: data.meta.years[data.nYears - 1] ?? 0,
  };
  const grid = {
    lats: data.meta.lats,
    lons: data.meta.lons,
    nLats: data.nLats,
    nLons: data.nLons,
  };

  let state = parseHash(window.location.hash, limits);

  const host = element("map");
  const fieldCanvas = element<HTMLCanvasElement>("field");
  const outlineCanvas = element<HTMLCanvasElement>("outlines");
  const caption = element("caption");
  const legend = element("legend");

  element("source").textContent =
    `Data: ${data.meta.source}. ${data.meta.licence} Built ${data.meta.built_at}.`;
  element("coverage").textContent =
    `A cell is left grey unless at least ${Math.round(DEFAULT_MIN_COVERAGE * 100)}% of the years in both its window and its baseline have data.`;

  // Rebuilt only when the canvas size or the region changes.
  let lookup: Int32Array | null = null;
  let image: ImageData | null = null;
  let layoutKey = "";
  let currentLimit = -1;

  function layout(): boolean {
    if (host.clientWidth < 2 || host.clientHeight < 2) return false;

    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const width = Math.round(host.clientWidth * dpr);
    const height = Math.round(host.clientHeight * dpr);

    const key = `${width}x${height}:${state.region}`;
    if (key === layoutKey) return lookup !== null;
    layoutKey = key;

    for (const canvas of [fieldCanvas, outlineCanvas]) {
      canvas.width = width;
      canvas.height = height;
    }

    const fieldCtx = fieldCanvas.getContext("2d");
    const outlineCtx = outlineCanvas.getContext("2d");
    if (!fieldCtx || !outlineCtx) throw new Error("no 2d canvas context");

    const projection = projectionFor(state.region, width, height);
    assertPseudocylindrical(projection);

    lookup = buildLookup(projection, width, height, grid);
    image = fieldCtx.createImageData(width, height);
    drawOutlines(outlineCtx, projection, land, dpr, state.region === "world");
    return true;
  }

  function repaint(): void {
    if (!layout() || !lookup || !image) return;

    performance.mark("repaint:start");

    const field = computeField(data, prefix, {
      baselineStart: state.baselineStart,
      baselineEnd: state.baselineEnd,
      windowYears: state.windowYears,
      year: state.year,
      minCoverage: DEFAULT_MIN_COVERAGE,
    });

    paintField(image, field, lookup, lut, state.limit);
    fieldCanvas.getContext("2d")?.putImageData(image, 0, 0);

    caption.textContent = describe(state, fieldGlobalMean(field, data.meta.lats, data.nLons));
    if (state.limit !== currentLimit) {
      currentLimit = state.limit;
      renderLegend(legend, lut, state.limit);
    }

    performance.mark("repaint:end");
    performance.measure("repaint", "repaint:start", "repaint:end");
  }

  const player = new Player(PLAY_INTERVAL, () => {
    apply({ year: nextYear(state.year, limits, state.windowYears) });
  });

  const controls = mountControls(element("controls"), {
    limits,
    initial: state,
    initialSpeed: 1,
    onChange: (patch) => apply(patch),
    onTogglePlay: () => {
      player.toggle();
      controls.setPlaying(player.playing);
    },
    onSpeed: (speed) => player.setSpeed(speed),
  });

  let hashWeWrote = "";

  function apply(patch: Partial<ViewState>): void {
    const merged: ViewState = { ...state, ...patch };
    // A wider window can push the year below the first year it can cover.
    state = { ...merged, year: clampYear(merged.year, limits, merged.windowYears) };

    hashWeWrote = serialiseHash(state);
    if (window.location.hash !== hashWeWrote) {
      window.history.replaceState(null, "", hashWeWrote);
    }

    controls.sync(state);
    repaint();
  }

  window.addEventListener("hashchange", () => {
    // Only react to someone else's navigation, not to our own writes.
    if (window.location.hash === hashWeWrote) return;
    apply(parseHash(window.location.hash, limits));
  });

  // Space toggles playback, unless the focused control uses space itself.
  window.addEventListener("keydown", (event) => {
    if (event.key !== " " && event.code !== "Space") return;

    const target = event.target;
    if (target instanceof HTMLElement) {
      const tag = target.tagName;
      const typed = target instanceof HTMLInputElement && target.type !== "range";
      if (tag === "BUTTON" || tag === "SELECT" || tag === "A" || typed) return;
    }

    event.preventDefault();
    player.toggle();
    controls.setPlaying(player.playing);
  });

  new ResizeObserver(() => repaint()).observe(host);

  apply(state);
  document.body.dataset["ready"] = "true";
}

start().catch((error: unknown) => {
  const caption = document.getElementById("caption");
  if (caption) caption.textContent = `Could not load the data: ${String(error)}`;
});
