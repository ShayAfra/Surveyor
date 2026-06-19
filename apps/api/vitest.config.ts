import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Disable parallel file execution: better-sqlite3 uses a single in-memory
    // Database instance shared across all imports within a Vitest worker thread.
    // Running files in parallel causes concurrent write transactions from
    // different test files on the same Database object, producing
    // "database is locked" errors. Sequential execution eliminates this.
    fileParallelism: false,
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    env: {
      // Use an in-memory SQLite database for all tests so they never touch the
      // real data file and each test worker starts with a fresh, isolated DB.
      DB_PATH: ":memory:",
    },
  },
});
