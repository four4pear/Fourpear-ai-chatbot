import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Gömülü Postgres (PGlite) yoğun makinede açılırken 10 sn'yi aşabiliyor.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
