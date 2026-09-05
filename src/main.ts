/**
 * Step 2: the default view, drawn once. No controls yet.
 *
 * World, Equal Earth, the mean of 2020-2024 against the 1951-1980 baseline,
 * on a blue-grey-red ramp clamped at +/-2 degC.
 */

import type { GeoPermissibleObjects } from "d3-geo";
import { feature } from "topojson-client";

import { buildPrefixSums, computeField, fieldGlobalMean, DEFAULT_MIN_COVERAGE } from "./compute.js";
import { loadGistemp, type GistempData } from "./data.js";
import { buildPalette, MISSING_RGB } from "./palette.js";
import {
  assertPseudocylindrical,
  buildLookup,
  createProjection,
  drawOutlines,
  fitProjection,
  paintField,
} from "./render.js";
import "./style.css";

/** The default view from the brief. Step 3 makes these adjustable. */
const VIEW = {
  baselineStart: 1951,
  baselineEnd: 1980,
  windowYears: 5,
  year: 2024,
  minCoverage: DEFAULT_MIN_COVERAGE,
} as const;

/** The ramp saturates here, so +2 degC and +4 degC look the same. */
const LIMIT = 2;

/** Above this the lookup and the ImageData cost more than the sharpness is worth. */
const MAX_DPR = 2;

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
  const collection = feature(
    topology as never,
    topology.objects.land as never,
  ) as unknown as GeoPermissibleObjects;
  return collection;
}

function renderLegend(host: HTMLElement, lut: Uint8ClampedArray): void {
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
    `Colour scale from ${LIMIT} degrees Celsius cooler, through no change, to ${LIMIT} degrees warmer`,
  );

  const ticks = document.createElement("div");
  ticks.className = "ramp-ticks";
  for (const value of [-LIMIT, -LIMIT / 2, 0, LIMIT / 2, LIMIT]) {
    const tick = document.createElement("span");
    tick.textContent = value === 0 ? "0" : `${formatSigned(value).replace(".00", "")} °C`;
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

function describe(data: GistempData, field: Float32Array): string {
  const from = VIEW.year - VIEW.windowYears + 1;
  const mean = fieldGlobalMean(field, data.meta.lats, data.nLons);
  return (
    `${VIEW.year} — mean of ${from}–${VIEW.year} vs ${VIEW.baselineStart}–${VIEW.baselineEnd}. ` +
    `Global average ${formatSigned(mean)} °C.`
  );
}

async function start(): Promise<void> {
  const base = import.meta.env.BASE_URL;
  const [data, land] = await Promise.all([loadGistemp(base), loadLand(base)]);

  const prefix = buildPrefixSums(data);
  const field = computeField(data, prefix, VIEW);
  const lut = buildPalette();

  element("caption").textContent = describe(data, field);
  element("source").textContent =
    `Data: ${data.meta.source}. ${data.meta.licence} Built ${data.meta.built_at}.`;
  renderLegend(element("legend"), lut);

  const host = element("map");
  const fieldCanvas = element<HTMLCanvasElement>("field");
  const outlineCanvas = element<HTMLCanvasElement>("outlines");
  const grid = {
    lats: data.meta.lats,
    lons: data.meta.lons,
    nLats: data.nLats,
    nLons: data.nLons,
  };

  // Nothing depends on the viewport but the lookup, so redraw only when the
  // pixel size actually changes — a resize that rounds to the same canvas is free.
  let lastSize = "";

  function draw(): void {
    if (host.clientWidth < 2 || host.clientHeight < 2) return;

    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const width = Math.round(host.clientWidth * dpr);
    const height = Math.round(host.clientHeight * dpr);

    const size = `${width}x${height}`;
    if (size === lastSize) return;
    lastSize = size;

    for (const canvas of [fieldCanvas, outlineCanvas]) {
      canvas.width = width;
      canvas.height = height;
    }

    const fieldCtx = fieldCanvas.getContext("2d");
    const outlineCtx = outlineCanvas.getContext("2d");
    if (!fieldCtx || !outlineCtx) throw new Error("no 2d canvas context");

    const projection = fitProjection(createProjection(), width, height);
    assertPseudocylindrical(projection);

    const lookup = buildLookup(projection, width, height, grid);
    const image = fieldCtx.createImageData(width, height);
    paintField(image, field, lookup, lut, LIMIT);
    fieldCtx.putImageData(image, 0, 0);

    drawOutlines(outlineCtx, projection, land, dpr);
  }

  draw();
  document.body.dataset["ready"] = "true";

  new ResizeObserver(() => draw()).observe(host);
}

start().catch((error: unknown) => {
  element("caption").textContent = `Could not load the data: ${String(error)}`;
});
