// v3: the sync checks that keep registry3.ts accurate. Each test derives a frozen
// list again from the engine sources and card data and fails on any difference,
// in either direction:
//   - the game gained a property/trigger/family the encoder does not know: the
//     encoder cannot see information that is visible in the game, so freeze the
//     new list and retrain;
//   - the frozen list has an entry the game no longer uses: a dead plane, to be
//     pruned at the next retrain.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PROPERTIES3, TRIGGER_TYPES3, FAMILIES3 } from "./registry3";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "../../..");
const ENGINE_DIR = path.join(APP_ROOT, "src", "engine");
const DATA_DIR = path.join(APP_ROOT, "public", "data");
const TYPES_TS = path.join(APP_ROOT, "src", "data", "types.ts");

function engineSources(): string[] {
  return fs
    .readdirSync(ENGINE_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => fs.readFileSync(path.join(ENGINE_DIR, f), "utf-8"));
}

function cardDataFiles(): unknown[] {
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.startsWith("cards_") && f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf-8")));
}

/** Collect every string value of `key` anywhere in a JSON tree. */
function collectKey(tree: unknown, key: string, into: Set<string>): void {
  if (Array.isArray(tree)) {
    for (const v of tree) collectKey(v, key, into);
  } else if (tree && typeof tree === "object") {
    for (const [k, v] of Object.entries(tree)) {
      if (k === key && typeof v === "string" && v) into.add(v);
      else collectKey(v, key, into);
    }
  }
}

describe("registry3, sync gates against engine + data", () => {
  it("PROPERTIES3 == every property literal the engine reads/writes + data `property:` values", () => {
    const found = new Set<string>();
    // Engine: properties.has("X") / .add("X") / .delete("X") string literals.
    const re = /(?:properties|auraProperties|props|granted|nextAura)\s*\.\s*(?:has|add|delete)\(\s*"([A-Za-z0-9_]+)"\s*\)/g;
    for (const src of engineSources()) {
      for (const m of src.matchAll(re)) found.add(m[1]);
    }
    // Data: SetPropertyData / ChiefPropertyAura etc. carry `property: "X"`.
    for (const tree of cardDataFiles()) collectKey(tree, "property", found);
    expect([...found].sort()).toEqual([...PROPERTIES3]);
  });

  it("TRIGGER_TYPES3 == the TriggerType union members in data/types.ts", () => {
    // Strip // comments first, the union's doc comments contain French " ; "
    // which broke a naive non-greedy match up to the first semicolon. [^\n]*
    // (not .*$): the file is CRLF and `.` refuses \r, so an EOL-anchored strip
    // silently no-ops on every line.
    const src = fs.readFileSync(TYPES_TS, "utf-8").replace(/\/\/[^\n]*/g, "");
    const unionSrc = src.match(/export type TriggerType =([\s\S]*?);/);
    expect(unionSrc, "TriggerType union not found in types.ts").toBeTruthy();
    const members = [...unionSrc![1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]).sort();
    expect(members).toEqual([...TRIGGER_TYPES3]);
  });

  it("FAMILIES3 == every family a rule reads (data `family:` fields; engine literals are a subset)", () => {
    const found = new Set<string>();
    for (const tree of cardDataFiles()) collectKey(tree, "family", found);
    // Engine hardcodes (Phorzerker fusion, Tas d'Os pickup) must already be
    // covered by the data scan, assert that too, so an engine-only family
    // could never silently drop out of the scan.
    for (const lit of ["Chafer", "Phorreur"]) expect(found.has(lit), `engine literal ${lit} missing from data scan`).toBe(true);
    expect([...found].sort()).toEqual([...FAMILIES3]);
  });
});
