import { defineConfig, configDefaults } from "vitest/config";

// Full suite: needs the card data built locally (see pipeline/README.md). Without it,
// the engine tests fail at import time, because the test kit loads the card pool from disk.
//
// The four slow AI benchmarks (arena / MCTS / self-play) are left out: they take minutes.
// Run them one by one when needed.
export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      "**/src/ai/arena.test.ts",
      "**/src/ai/mcts.test.ts",
      "**/src/ai/detmcts.test.ts",
      "**/src/ai/selfplay.test.ts",
    ],
  },
});
