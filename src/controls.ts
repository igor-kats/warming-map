/**
 * The control panel, and the playback clock.
 *
 * Every control is a native input — radios, a range, number fields, buttons —
 * so keyboard support, focus order and screen-reader semantics come from the
 * browser rather than from re-implementation here. The panel owns no view
 * state: it renders whatever it is given and reports what the reader asked for.
 */

import { PALETTE_LABELS, PALETTE_OPTIONS, type PaletteName } from "./palette.js";
import {
  BASELINE_PRESETS,
  LIMIT_OPTIONS,
  REGION_LABELS,
  REGION_OPTIONS,
  SPEED_OPTIONS,
  WINDOW_OPTIONS,
  firstPlayableYear,
  type PaletteLimit,
  type RecordLimits,
  type Region,
  type ViewState,
  type WindowYears,
} from "./url.js";

export interface ControlsOptions {
  readonly limits: RecordLimits;
  readonly initial: ViewState;
  readonly initialSpeed: number;
  readonly onChange: (patch: Partial<ViewState>) => void;
  readonly onTogglePlay: () => void;
  readonly onSpeed: (speed: number) => void;
}

export interface Controls {
  /** Push view state into the inputs, e.g. after a hash change or a play tick. */
  readonly sync: (state: ViewState) => void;
  readonly setPlaying: (playing: boolean) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function group(legend: string): { root: HTMLFieldSetElement; body: HTMLDivElement } {
  const root = el("fieldset", "group");
  const caption = el("legend");
  caption.textContent = legend;
  const body = el("div", "group-body");
  root.append(caption, body);
  return { root, body };
}

/** A radio set. Native radios give arrow-key navigation and a single tab stop. */
function radios<T extends string | number>(
  name: string,
  options: readonly T[],
  label: (value: T) => string,
  onPick: (value: T) => void,
): { root: HTMLDivElement; select: (value: T) => void } {
  const root = el("div", "choices");
  const inputs = new Map<T, HTMLInputElement>();

  for (const value of options) {
    const id = `${name}-${String(value)}`;

    const input = el("input");
    input.type = "radio";
    input.name = name;
    input.id = id;
    input.value = String(value);
    input.addEventListener("change", () => {
      if (input.checked) onPick(value);
    });

    const text = el("label");
    text.htmlFor = id;
    text.textContent = label(value);

    inputs.set(value, input);
    root.append(input, text);
  }

  return {
    root,
    select(value) {
      const input = inputs.get(value);
      if (input && !input.checked) input.checked = true;
    },
  };
}

export function mountControls(host: HTMLElement, options: ControlsOptions): Controls {
  const { limits, initial, onChange } = options;
  host.replaceChildren();

  // --- baseline -----------------------------------------------------------
  const baseline = group("Baseline");

  function yearField(labelText: string, value: number, apply: (year: number) => void) {
    const wrap = el("span", "field");
    const input = el("input");
    input.type = "number";
    input.min = String(limits.firstYear);
    input.max = String(limits.lastYear);
    input.step = "1";
    input.value = String(value);
    input.setAttribute("aria-label", labelText);
    input.addEventListener("change", () => {
      const parsed = Number(input.value);
      if (Number.isInteger(parsed)) apply(parsed);
    });
    wrap.append(input);
    return { wrap, input };
  }

  const startField = yearField("Baseline start year", initial.baselineStart, (year) =>
    onChange({ baselineStart: year }),
  );
  const endField = yearField("Baseline end year", initial.baselineEnd, (year) =>
    onChange({ baselineEnd: year }),
  );

  const range = el("div", "range");
  const dash = el("span", "dash");
  dash.textContent = "–";
  range.append(startField.wrap, dash, endField.wrap);

  const presets = el("div", "choices");
  for (const [start, end] of BASELINE_PRESETS) {
    const button = el("button");
    button.type = "button";
    button.className = "preset";
    button.textContent = `${start}–${end}`;
    button.addEventListener("click", () =>
      onChange({ baselineStart: start, baselineEnd: end }),
    );
    presets.append(button);
  }

  baseline.body.append(range, presets);

  // --- window, scale, region ---------------------------------------------
  const windowGroup = group("Window");
  const windowRadios = radios<WindowYears>(
    "window",
    WINDOW_OPTIONS,
    (value) => (value === 1 ? "1 year" : `${value} years`),
    (value) => onChange({ windowYears: value }),
  );
  windowGroup.body.append(windowRadios.root);

  const scaleGroup = group("Scale");
  const scaleRadios = radios<PaletteLimit>(
    "scale",
    LIMIT_OPTIONS,
    (value) => `±${value} °C`,
    (value) => onChange({ limit: value }),
  );
  scaleGroup.body.append(scaleRadios.root);

  const paletteGroup = group("Colours");
  const paletteRadios = radios<PaletteName>(
    "palette",
    PALETTE_OPTIONS,
    (value) => PALETTE_LABELS[value],
    (value) => onChange({ palette: value }),
  );
  paletteGroup.body.append(paletteRadios.root);

  const regionGroup = group("Region");
  const regionRadios = radios<Region>(
    "region",
    REGION_OPTIONS,
    (value) => REGION_LABELS[value],
    (value) => onChange({ region: value }),
  );
  regionGroup.body.append(regionRadios.root);

  // --- playback -----------------------------------------------------------
  const play = el("button", "play");
  play.type = "button";
  play.setAttribute("aria-pressed", "false");
  play.textContent = "Play";
  play.addEventListener("click", () => options.onTogglePlay());

  const speedRadios = radios<number>(
    "speed",
    SPEED_OPTIONS,
    (value) => `${value}×`,
    (value) => options.onSpeed(value),
  );
  speedRadios.select(options.initialSpeed);

  const slider = el("input", "year");
  slider.type = "range";
  slider.step = "1";
  slider.min = String(firstPlayableYear(limits, initial.windowYears));
  slider.max = String(limits.lastYear);
  slider.value = String(initial.year);
  slider.setAttribute("aria-label", "Year");
  slider.addEventListener("input", () => onChange({ year: Number(slider.value) }));

  const readout = el("output", "readout");
  readout.textContent = String(initial.year);

  const speedWrap = el("span", "speed");
  const speedLabel = el("span", "speed-label");
  speedLabel.textContent = "Speed";
  speedWrap.append(speedLabel, speedRadios.root);

  const playbar = el("div", "playbar");
  playbar.append(play, speedWrap, slider, readout);

  host.append(
    baseline.root,
    windowGroup.root,
    scaleGroup.root,
    paletteGroup.root,
    regionGroup.root,
    playbar,
  );

  return {
    sync(state) {
      // The slider floor moves with the window, so set it before the value.
      const floor = firstPlayableYear(limits, state.windowYears);
      slider.min = String(floor);
      if (slider.value !== String(state.year)) slider.value = String(state.year);
      slider.setAttribute("aria-valuetext", `${state.year}`);
      readout.textContent = String(state.year);

      if (document.activeElement !== startField.input) {
        startField.input.value = String(state.baselineStart);
      }
      if (document.activeElement !== endField.input) {
        endField.input.value = String(state.baselineEnd);
      }

      windowRadios.select(state.windowYears);
      scaleRadios.select(state.limit);
      regionRadios.select(state.region);
      paletteRadios.select(state.palette);
    },

    setPlaying(playing) {
      play.setAttribute("aria-pressed", String(playing));
      play.textContent = playing ? "Pause" : "Play";
    },
  };
}

/**
 * A frame-driven clock that advances a year at a time.
 *
 * It paces itself off the wall clock rather than off frames, so a slow repaint
 * costs frames rather than drifting the animation, and a tab that was
 * backgrounded does not come back and fast-forward through the record.
 */
export class Player {
  private handle = 0;
  private previous = 0;
  private carried = 0;

  constructor(
    private readonly intervalAt1x: number,
    private readonly step: () => void,
  ) {}

  private speed = 1;

  get playing(): boolean {
    return this.handle !== 0;
  }

  setSpeed(speed: number): void {
    this.speed = speed;
  }

  start(): void {
    if (this.playing) return;
    this.previous = performance.now();
    this.carried = 0;
    const tick = (now: number): void => {
      const interval = this.intervalAt1x / this.speed;
      this.carried += now - this.previous;
      this.previous = now;
      if (this.carried >= interval) {
        // One step per frame at most: never burn through years off-screen.
        this.carried = Math.min(this.carried - interval, interval);
        this.step();
      }
      this.handle = requestAnimationFrame(tick);
    };
    this.handle = requestAnimationFrame(tick);
  }

  stop(): void {
    if (!this.playing) return;
    cancelAnimationFrame(this.handle);
    this.handle = 0;
  }

  toggle(): void {
    if (this.playing) this.stop();
    else this.start();
  }
}
