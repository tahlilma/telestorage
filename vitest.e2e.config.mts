import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * End-to-end suites (HTTP protocol, load shedding, real-browser UI). The
 * global setup boots isolated servers from the production build with the
 * simulated fleet — run `npm run build` first. E2E_BASE_URL targets an
 * existing server instead; never point it at one holding real data.
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.e2e.ts"],
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 60_000,
    globalSetup: ["tests/e2e/global-setup.ts"],
  },
});
