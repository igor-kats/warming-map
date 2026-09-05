/// <reference types="vitest/config" />
import { defineConfig } from "vite";

// `base` comes from the environment so a GitHub Pages project site (served from
// /warming-map/) and local dev both resolve the data files.
export default defineConfig({
  base: process.env["VITE_BASE"] ?? "/",
  build: {
    target: "es2022",
    // The .bin data file must be fetched, not inlined.
    assetsInlineLimit: 0,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
