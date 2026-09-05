/**
 * Screenshot the running dev server at a desktop and a phone width, and report
 * what the browser actually loaded. Usage: node scripts/screenshots.mjs [url]
 */
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://localhost:5173/";
const OUT = "docs/screenshots";

const TARGETS = [
  { name: "world-1280", width: 1280, height: 800, dpr: 1 },
  { name: "world-390", width: 390, height: 844, dpr: 2 },
];

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();

for (const target of TARGETS) {
  const context = await browser.newContext({
    viewport: { width: target.width, height: target.height },
    deviceScaleFactor: target.dpr,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();

  const started = Date.now();
  await page.goto(url, { waitUntil: "load" });
  await page.waitForSelector("body[data-ready='true']", { timeout: 30_000 });
  const ready = Date.now() - started;

  const metrics = await page.evaluate(() => {
    const resources = performance.getEntriesByType("resource");
    const nav = performance.getEntriesByType("navigation")[0];
    const paint = performance.getEntriesByType("paint");
    const sum = (key) =>
      resources.reduce((total, r) => total + (r[key] || 0), 0) + (nav?.[key] || 0);
    return {
      requests: resources.length + 1,
      transferred: sum("transferSize"),
      decoded: sum("decodedBodySize"),
      firstPaint: paint.find((p) => p.name === "first-paint")?.startTime ?? null,
      firstContentfulPaint:
        paint.find((p) => p.name === "first-contentful-paint")?.startTime ?? null,
      biggest: resources
        .map((r) => ({ name: new URL(r.name).pathname, transfer: r.transferSize }))
        .sort((a, b) => b.transfer - a.transfer)
        .slice(0, 4),
    };
  });

  const file = `${OUT}/${target.name}.png`;
  await page.screenshot({ path: file, fullPage: true });

  console.log(`\n${target.name}  ${target.width}x${target.height} @${target.dpr}x  -> ${file}`);
  console.log(`  requests            ${metrics.requests}`);
  console.log(`  transferred         ${(metrics.transferred / 1e6).toFixed(2)} MB`);
  console.log(`  decoded             ${(metrics.decoded / 1e6).toFixed(2)} MB`);
  console.log(`  first paint         ${metrics.firstPaint?.toFixed(0)} ms`);
  console.log(`  first contentful    ${metrics.firstContentfulPaint?.toFixed(0)} ms`);
  console.log(`  map painted         ${ready} ms after navigation started`);
  for (const r of metrics.biggest) {
    console.log(`    ${(r.transfer / 1e6).toFixed(2)} MB  ${r.name}`);
  }

  await context.close();
}

await browser.close();
