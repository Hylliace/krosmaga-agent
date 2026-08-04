import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Static determinism check: no call to the global generator in the engine. Every source of chance
// has to draw from the seeded stream (state.rng -> new Rng -> store rng.state back). The runtime
// tripwire only sees a stray call if a game reaches it; this static check always sees it.
// The only allowed exception: rng.ts (randomSeed, the initial seed of the live game).
describe("Garde déterminisme, jamais le générateur global dans src/engine", () => {
  it("aucun appel Math.random(hors rng.ts", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const offenders: string[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts") || f === "rng.ts") continue;
      const src = fs.readFileSync(path.join(dir, f), "utf-8");
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (/Math\.random\s*\(/.test(lines[i])) offenders.push(`${f}:${i + 1}: ${lines[i].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
