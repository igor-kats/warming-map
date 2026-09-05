/**
 * Measure recompute + redraw for each kind of control change, with and without
 * Chrome's CPU throttling. Usage: node scripts/perf.mjs [url] [width]
 *
 * "repaint" is the synchronous work the brief budgets: computeField, paintField
 * and putImageData. "to next frame" adds the wait for the browser to present
 * that frame, so it is what the reader actually perceives.
 */
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://localhost:5173/";
const width = Number(process.argv[3] ?? 1280);

async function run(page) {
  return page.evaluate(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    const pick = (sel) => document.querySelector(sel);
    const out = {};

    async function measure(bucket, act) {
      performance.clearMeasures("repaint");
      const t0 = performance.now();
      act();
      await frame();
      const toFrame = performance.now() - t0;
      const entries = performance.getEntriesByName("repaint");
      const repaint = entries.length ? entries[entries.length - 1].duration : NaN;
      (out[bucket] ??= []).push({ repaint, toFrame });
      await frame();
    }

    const slider = pick("input.year");
    const setYear = (y) => {
      slider.value = String(y);
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    };

    // Year steps: the common case, and what playback does every tick.
    for (let y = 1990; y < 2020; y++) await measure("year", () => setYear(y));

    for (const w of [1, 10, 5, 1, 10, 5])
      await measure("window", () => pick(`input[name="window"][value="${w}"]`).click());

    const presets = [...document.querySelectorAll("button.preset")];
    for (let i = 0; i < 6; i++) await measure("baseline", () => presets[i % presets.length].click());

    for (const p of [1, 3, 4, 2, 1, 2])
      await measure("scale", () => pick(`input[name="scale"][value="${p}"]`).click());

    // Region also rebuilds the pixel lookup and redraws the coastlines.
    for (const r of ["eu", "na", "world", "eu", "world"])
      await measure("region", () => pick(`input[name="region"][value="${r}"]`).click());

    return out;
  });
}

function stats(samples, key) {
  const v = samples.map((s) => s[key]).filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const at = (q) => v[Math.min(v.length - 1, Math.floor(q * v.length))];
  return { n: v.length, median: at(0.5), p95: at(0.95), max: v[v.length - 1] };
}

const browser = await chromium.launch();

for (const rate of [1, 4]) {
  const context = await browser.newContext({
    viewport: { width, height: 800 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const client = await context.newCDPSession(page);
  if (rate > 1) await client.send("Emulation.setCPUThrottlingRate", { rate });

  await page.goto(url, { waitUntil: "load" });
  await page.waitForSelector("body[data-ready='true']", { timeout: 60_000 });
  const result = await run(page);

  console.log(`\n=== ${width}px, CPU throttling ${rate}x ===`);
  console.log("change      n   repaint median / p95 / max      to next frame median / p95");
  for (const [name, samples] of Object.entries(result)) {
    const r = stats(samples, "repaint");
    const f = stats(samples, "toFrame");
    console.log(
      `${name.padEnd(10)} ${String(r.n).padStart(2)}   ` +
        `${r.median.toFixed(1).padStart(6)} / ${r.p95.toFixed(1).padStart(6)} / ${r.max.toFixed(1).padStart(6)} ms      ` +
        `${f.median.toFixed(1).padStart(6)} / ${f.p95.toFixed(1).padStart(6)} ms`,
    );
  }

  await context.close();
}

await browser.close();
