// Contracts of the two performance caches. A cache in a copy-on-write engine is a
// risky place: these tests lock the two invariants that, if broken, corrupt things
// without any warning.
import { describe, it, expect } from "vitest";
import { cards, card, mkCreature, scenario } from "./testkit";
import { validSpawnCells } from "./queries";
import { withAuras } from "./rules";
import { registerCards } from "./cardRegistry";

describe("validSpawnCells : l'instance memorisee ne sort jamais du cache", () => {
  it("deux appels rendent des tableaux DISTINCTS (copie defensive)", () => {
    cards();
    const s = scenario([]);
    const a = validSpawnCells(s, "ally");
    const b = validSpawnCells(s, "ally");
    expect(a).toEqual(b);      // meme contenu
    expect(a).not.toBe(b);     // but not the same instance
  });

  it("trier le resultat en place ne corrompt pas les appels suivants", () => {
    cards();
    const s = scenario([]);
    const attendu = validSpawnCells(s, "ally").map((c) => `${c.x},${c.y}`);
    // A caller that sorts in the other order: before the defensive copy, it reordered
    // the memoized instance and every later call got that order.
    validSpawnCells(s, "ally").sort((p, q) => q.x - p.x || q.y - p.y);
    expect(validSpawnCells(s, "ally").map((c) => `${c.x},${c.y}`)).toEqual(attendu);
  });

  it("vider le resultat en place ne vide pas le cache", () => {
    cards();
    const s = scenario([]);
    const n = validSpawnCells(s, "ally").length;
    expect(n).toBeGreaterThan(0);
    validSpawnCells(s, "ally").length = 0; // troncature en place
    expect(validSpawnCells(s, "ally")).toHaveLength(n);
  });
});

describe("auraProfile : le cache ne fige jamais une ABSENCE de carte", () => {
  it("une aura de CHEF s'applique meme si le profil a ete demande registre VIDE", () => {
    // #15 Tofu Royal : CHEF, +1 AT et +1 PM a vos autres Tofus.
    // #453 Tofu : AT 1, PM 5.
    cards(); // fill the registry to read the definitions
    const royal = card(15);
    const tofuDef = card(453);
    expect(royal.effects?.some((e) => e.type === "ChiefAura")).toBe(true);

    const board = () => [
      mkCreature(1, "ally", { x: 8, y: 2 }, {
        cardId: 15, currentAttack: royal.attack ?? 4, baseAttack: royal.attack ?? 4,
        baseMovement: royal.movement ?? 4, printedMovement: royal.movement ?? 4,
      }),
      mkCreature(2, "ally", { x: 6, y: 1 }, {
        cardId: 453, currentAttack: tofuDef.attack ?? 1, baseAttack: tofuDef.attack ?? 1,
        printedAttack: tofuDef.attack ?? 1,
        baseMovement: tofuDef.movement ?? 5, printedMovement: tofuDef.movement ?? 5,
      }),
    ];

    const attendu = (tofuDef.attack ?? 1) + 1; // derive du TEXTE : « +1 AT a vos autres Tofus »

    // The order matters: the auras are asked for with an empty registry before any call
    // with a filled registry. Otherwise the correct profile would already be cached and
    // the faulty path would never run, so the test would pass even without the fix
    // (checked: an earlier version of this test did exactly that).
    // Empty registry -> getCard returns undefined -> empty profile. The bug was to
    // memoize it: the card lost its auras for the rest of the process, without any
    // warning.
    registerCards([]);
    withAuras(board());

    // Registry filled again. Careful: cards() from the testkit is memoized and does not
    // register a second time, so registerCards has to be called explicitly, otherwise
    // the registry stays empty and the test would measure that empty registry instead
    // of the cache's behaviour.
    registerCards([...cards().values()]);
    const apres = withAuras(board()).find((c) => c.instanceId === 2)!.currentAttack;
    expect(apres).toBe(attendu);
  });
});
