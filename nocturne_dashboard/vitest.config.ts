import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Unit tests for the console's pure logic.
 *
 * Scope is deliberate. What is covered here is the code that decides something:
 * how a run's counts become a progress rail, what a session token is allowed to
 * claim, when a sign-in is throttled, how bytes are shown to an analyst. What is
 * not covered is the code that only moves data across a boundary — Snowflake
 * queries, route handlers, React components. Those need a warehouse, a request,
 * or a browser to mean anything, and asserting against a mock of all three
 * tests the mock.
 *
 * The `coverage.include` list below is therefore an allowlist rather than the
 * whole tree, and the thresholds are real gates on it: a new branch in one of
 * these modules fails CI until it is tested.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // Node, not jsdom: nothing under test touches the DOM, and session.ts and
    // rate-limit.ts throw on purpose if they detect a browser global.
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // text for the CI log, lcov for external tooling, json-summary for the
      // step summary the workflow prints back into the PR.
      reporter: ["text", "text-summary", "lcov", "json-summary", "html"],
      reportsDirectory: "coverage",
      include: [
        "src/lib/actor-rollup.ts",
        "src/lib/format.ts",
        "src/lib/graph-timeline.ts",
        "src/lib/live-scan.ts",
        "src/lib/manual-upload.ts",
        "src/server/mock-assistant.ts",
        "src/server/query-cache.ts",
        "src/server/rate-limit.ts",
        "src/server/session.ts",
      ],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
});
