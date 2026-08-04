# Krosmaga Agent

[![CI](https://github.com/Hylliace/krosmaga-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/Hylliace/krosmaga-agent/actions/workflows/ci.yml)

A rules engine and an AI player for [Krosmaga](https://www.krosmaga.com/en), a card game
by Ankama. Each player has a hidden hand, hidden win conditions (some of your Dofus are
fake, and the opponent does not know which ones) and a lot of randomness.

Demo: https://krosmagoon.pages.dev

The AI can be played there at two levels, *normale* and *forte*. Both use the same value
network, the same belief model and the same search. Only the search budget changes: 2
sampled worlds × 40 simulations per decision for *normale*, 6 × 120 for *forte* (see
[`src/ai/browserAgent.ts`](src/ai/browserAgent.ts)).

## Why

The game has a built-in AI, but it only plays a small set of simple cards and follows a
few fixed rules. It does not try to guess what the opponent holds and it does not look
ahead. I wanted an opponent that plays the full card pool and deals with the hidden
information.

There is no strong existing opponent to test against, so all the results below come from
matches between two versions of the agent, with one component changed between them.

## Results

The main result: an expert iteration loop worked once. A value network trained on games
played by the search beat the search that produced its training games.

| New network against | Win rate | 95% interval (Wilson) |
|---|---:|---:|
| its teacher (500 games, seats alternate, no draws) | 72.6% | [68.5, 76.3] |
| the network deployed before it | 70.2% | [66.0, 74.0] |

Against the teacher, both sides use the same search, the same belief model and the same
budget (2 worlds × 20 simulations). Only the evaluation at the leaves differs.

I ran the loop four times and only the first round gave a gain. In round 2, none of the
seven new networks went above 46.8% against their teacher. Rounds 3 and 4 did not give a
gain either: the last network I measured is at 49.9% over 733 games. My reading is that
the first round is the only one where the training data changes kind, from a hand-written
heuristic to a search. After that the teacher is already a search, the new network
mostly learns what it already knows, and the teacher would need more compute to keep
improving.

What did not work:

- a policy network used as a prior for the search loses (30% against value only);
- self-play with no anchor diverges within three iterations;
- more data with the same teacher gives no gain.

## How it works

- **Belief model.** A probability over the opponent's hand and over which of their Dofus
  are real, built only from public information. On held-out decks (3 folds) its Brier
  score is 0.022, against 0.027 for a baseline that only uses deck statistics (18.4%
  lower), with an ECE of 0.007.
- **Search.** Determinized MCTS: possible worlds are sampled from the belief, UCT runs in
  each world, and the visit counts are added up.
- **Value network.** Used at the leaves of the search. A small residual CNN over the board
  (2 blocks, 48 channels), an MLP over global values and a linear layer over card
  vectors, about 833k parameters, with a tanh output. The CNN is only about 12% of the
  parameters.
- **Expert rules.** On top of the search there are 27 rules, written after reviewing games
  with an experienced player. Each one has a test built on the game state where the
  problem showed up.

The engine and the agent are written in TypeScript with no runtime dependencies (about
26,000 lines without tests: 16,700 for the engine, 8,500 for the agent). Training uses
PyTorch with an ONNX export, and the browser runs the network with a small hand-written
WASM SIMD kernel.

## How the numbers were measured

- Data is split into train and test sets by game, not by position, since positions from
  the same game are strongly correlated.
- Each measurement runs on a fixed copy of the code, so it can be run again later.
- The engine is deterministic: the same state and the same seed give the same game. In
  the largest generation run (8,000 games), no game broke this.
- Every win rate comes with a Wilson interval. The 500 games above are 4 seeds × 125
  games, so they are not fully independent: the spread between seeds was 5 to 9 points,
  more than the ±3.9 of the interval. A new network is only accepted when the lower
  bound is above 50%, so a result like 53.8% [49.4, 58.1] counts as no improvement.

These numbers cannot be recomputed from this repository alone, because they need the
card data and a deck corpus, which are not included.

## Card data and tests

Krosmaga and its cards, texts, art and sounds belong to Ankama, and none of them are in
this repository. The [`pipeline/`](pipeline/README.md) folder has the scripts that build
the card data from a local copy of the game.

Without the card data, `npm test` runs a small suite on ten made-up cards
([`src/engine/fixtures/`](src/engine/fixtures/)). It covers summoning and costs, summoning
sickness, family auras, stats that change when a creature is wounded, melee where both
sides strike at once, damage reactions, units that cannot be moved, single-target
spells, blocked lines of fire, and the rule that the engine never changes the state it is
given.

```bash
npm install
npm test
```

With the card data built locally, the full suite (2,381 tests) runs with:

```bash
npm run test:full
```

Some agent tests also need a deck corpus in `decks-corpus/`.

## Layout

```
src/engine/            rules: turns, movement, combat, deaths, triggers, effects
src/engine/fixtures/   made-up card pool and the tests that run without game data
src/ai/                agent: belief model, determinization, search, encoders, arenas
src/ai/train/py/       PyTorch training and ONNX export
src/data/              card types shared by the engine and the agent
pipeline/              scripts that build the card data from a local copy of the game
```

## License

MIT for the code, see [LICENSE](LICENSE).
