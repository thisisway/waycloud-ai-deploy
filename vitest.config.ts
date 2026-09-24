import { defineConfig } from "vitest/config";

// Several test files start an embedded Postgres (PGlite, WASM) in parallel: give hooks room to breathe.
export default defineConfig({ test: { include: ["tests/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 60_000 } });
