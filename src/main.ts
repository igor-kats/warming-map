/**
 * Scaffold entry point (step 0). It loads the data files and reports what it
 * found, so `npm run dev` proves that the Python build pipeline and the site
 * agree on the binary format. The map itself is step 2.
 */

import { loadGistemp, valueAt } from "./data.js";

const app = document.querySelector<HTMLElement>("#app");

async function start(root: HTMLElement): Promise<void> {
  root.textContent = "Loading NASA GISTEMP…";

  const data = await loadGistemp(import.meta.env.BASE_URL);
  const { meta } = data;
  const last = data.nYears - 1;

  let present = 0;
  for (let lat = 0; lat < data.nLats; lat++) {
    for (let lon = 0; lon < data.nLons; lon++) {
      if (!Number.isNaN(valueAt(data, last, lat, lon))) present++;
    }
  }

  root.textContent =
    `${meta.source}: ${meta.years[0]}–${meta.years[last]}, ` +
    `${data.nLats}×${data.nLons} cells, anomalies vs ${meta.baseline}. ` +
    `${present} of ${data.nLats * data.nLons} cells have data for ${meta.years[last]}.`;
}

if (app) {
  start(app).catch((error: unknown) => {
    app.textContent = `Could not load the data: ${String(error)}`;
  });
}
