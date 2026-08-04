import { defineConfig } from "vitest/config";

// Default suite: runs on a fresh clone, with no game data.
//
// The full engine suite is written against the real card pool, which is not in this
// repository, so it cannot run without a local extraction. `npm test` only runs the
// tests on the made-up cards in src/engine/fixtures/. After a local extraction, run
// everything with `npm run test:full`.
export default defineConfig({
  test: {
    include: ["src/engine/fixtures/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.git/**"],
  },
});
