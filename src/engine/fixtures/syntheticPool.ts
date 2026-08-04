// Synthetic card pool, with no game data.
//
// Why this file exists: the engine is tested against the real card pool, read from public/data
// by testkit.ts. That data belongs to Ankama and cannot be redistributed, so a public repository
// cannot include it. Without it, the 2,457 engine tests do not even start (they fail at the first
// import).
//
// This pool fixes that. The cards are entirely fictional (made-up names, texts and values), built
// to test the engine's mechanics, not to copy any existing card design. A game mechanic (a chief
// aura, a hit back, a shooting range) belongs to no one; the design of a specific card does.
//
// Ids start at 90000 so they never collide with the real catalog.
import type { Card } from "../../data/types";

const base = {
  description: "",
  illustration: null, // no art: these cards are fictional and never rendered
  cardClass: "Test",
  god: "None" as const,
  rarity: "Common" as const,
  families: [] as string[],
  properties: [] as string[],
  effects: [] as Card["effects"],
};

export const ID = {
  GRUNT: 90001,
  CHIEF: 90002,
  KIN: 90003,
  ARCHER: 90004,
  WALL: 90005,
  RETORT: 90006,
  HERALD: 90007,
  BLEEDER: 90008,
  BOLT: 90009,
  FILLER: 90010,
} as const;

export const SYNTHETIC_POOL: Card[] = [
  {
    ...base, id: ID.GRUNT, name: "Test Grunt", cardType: "Summon",
    cost: 2, life: 3, attack: 2, movement: 2, castTarget: "EmptyAlliedSpawnCells",
    description: "Une creature de base, sans capacite.",
  },
  {
    ...base, id: ID.CHIEF, name: "Test Chief", cardType: "Summon",
    cost: 4, life: 4, attack: 2, movement: 2, castTarget: "EmptyAlliedSpawnCells",
    description: "CHEF : +1 AT a vos autres Testkin.",
    families: ["Testkin"],
    effects: [{ type: "ChiefAura", stat: "attack", amount: 1, family: "Testkin" }] as Card["effects"],
  },
  {
    ...base, id: ID.KIN, name: "Test Kin", cardType: "Summon",
    cost: 2, life: 3, attack: 1, movement: 2, castTarget: "EmptyAlliedSpawnCells",
    description: "Un Testkin ordinaire.",
    families: ["Testkin"],
  },
  {
    ...base, id: ID.ARCHER, name: "Test Archer", cardType: "Summon",
    cost: 3, life: 2, attack: 3, movement: 1, castTarget: "EmptyAlliedSpawnCells",
    description: "PORTEE : tire a distance devant lui.",
    effects: [{ type: "ShooterRangeData", RangeMin: 1, RangeMax: 3 }] as Card["effects"],
  },
  {
    ...base, id: ID.WALL, name: "Test Wall", cardType: "Summon",
    cost: 2, life: 5, attack: 0, movement: 0, castTarget: "EmptyAlliedCells",
    description: "MUR : ne se deplace pas.",
    properties: ["Statue"],
  },
  {
    ...base, id: ID.RETORT, name: "Test Retort", cardType: "Summon",
    cost: 3, life: 5, attack: 2, movement: 2, castTarget: "EmptyAlliedSpawnCells",
    description: "CONTRE COUP : ajoute un Test Grunt a votre main.",
    triggers: [{ trigger: "CONTRE_COUP", effects: [{ type: "AddCardToHand", cardId: ID.GRUNT, amount: 1 }] }] as Card["triggers"],
  },
  {
    ...base, id: ID.HERALD, name: "Test Herald", cardType: "Summon",
    cost: 4, life: 3, attack: 2, movement: 2, castTarget: "EmptyAlliedSpawnCells",
    description: "APPARITION : inflige 2 degats.",
    triggers: [{ trigger: "APPARITION", effects: [{ type: "DamageData", Damage: 2 }] }] as Card["triggers"],
  },
  {
    ...base, id: ID.BLEEDER, name: "Test Bleeder", cardType: "Summon",
    cost: 3, life: 5, attack: 1, movement: 2, castTarget: "EmptyAlliedSpawnCells",
    description: "BLESSE : gagne +2 AT.",
    effects: [{ type: "WoundedStatBoost", stat: "attack", amount: 2 }] as Card["effects"],
  },
  {
    ...base, id: ID.BOLT, name: "Test Bolt", cardType: "Spell",
    cost: 2, castTarget: "AnySummon",
    description: "Inflige 2 degats a une invocation.",
    effects: [{ type: "DamageData", Damage: 2 }] as Card["effects"],
  },
  {
    ...base, id: ID.FILLER, name: "Test Filler", cardType: "Spell",
    cost: 9, castTarget: "AlliedGod",
    description: "Carte de remplissage : sert a garnir une pioche.",
  },
];
