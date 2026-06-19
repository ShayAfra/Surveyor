import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    // Sequential execution: prevents concurrent access to shared globals
    // (matches the pattern used in apps/api/vitest.config.ts)
    fileParallelism: false,
  },
});
