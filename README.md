# Krosmaga Agent

[![CI](https://github.com/Hylliace/krosmaga-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/Hylliace/krosmaga-agent/actions/workflows/ci.yml)

A rules engine and an AI player for [Krosmaga](https://www.krosmaga.com/en), a card game
by Ankama. Each player has a hidden hand, hidden win conditions (some of your Dofus are
fake, and the opponent does not know which ones) and a lot of randomness.

Against the AI that comes with the game, on the official servers, it won 49 of 50 games
(see [below](#against-the-games-own-ai)).

Demo: https://krosmagoon.pages.dev

The AI can be played there at two levels, *normale* and *forte*. Both use the same value
network, the same belief model and the same search. Only the search budget changes, with
2 sampled worlds and 40 simulations per decision for *normale* and 6 worlds and 120
simulations for *forte* (see [`src/ai/browserAgent.ts`](src/ai/browserAgent.ts)). Both
levels judge their moves on four sampled hands of the player, never on the real one.

## Against the game's own AI

I connected the agent to the official game client and played 50 games in a row against the
AI that comes with the game. The agent won 49 of them.

| Games | Wins | Losses | Win rate | 95% interval (Wilson) |
|---|---:|---:|---:|---:|
| 50 | 49 | 1 | 98.0% | [89.5, 99.6] |

| Opponent | Wins |
|---|---:|
| Iop | 9 / 9 |
| Feca | 7 / 7 |
| Sacrieur | 6 / 7 |
| Enutrof | 6 / 6 |
| Xelor | 5 / 5 |
| Ecaflip | 5 / 5 |
| Sram | 5 / 5 |
| Eniripsa | 3 / 3 |
| Cra | 2 / 2 |
| Sadida | 1 / 1 |

The agent always played the same deck, an Iop deck built around the Fratrie family and
Tikoko, with 4 sampled worlds and 200 simulations per decision and the honest root with four
sampled hands. All 50 games count, none was left out. The one loss was the fifth game,
against a Sacrieur deck. A game lasted 10 turns at the median. How the series was run is in
[`method.md`](method.md#games-against-the-ai-of-the-game).

I think this shows that the agent is well above the AI of the game, but it says nothing
yet about human players, and it was measured with one deck only. The code that connects the
agent to the game client is not in this repository.

## Why

The game has a built-in AI, but it only plays a small set of simple cards and follows a
few fixed rules. It does not try to guess what the opponent holds and it does not look
ahead. I wanted an opponent that plays the full card pool and deals with the hidden
information.

I kept working on it after August because I was not happy with its level. It is still far
from a world-class player.

There is no strong existing opponent to test against, so most results below come from
matches between two versions of the agent, with one component changed between them.

## Results

### Expert iteration

A value network trained on games played by the search beat the search that produced its
training games.

| New network against | Win rate | 95% interval (Wilson) |
|---|---:|---:|
| its teacher (500 games, seats alternate, no draws) | 72.6% | [68.5, 76.3] |
| the network deployed before it | 70.2% | [66.0, 74.0] |

Against the teacher, both sides use the same search, the same belief model and the same
budget (2 worlds × 20 simulations). Only the evaluation at the leaves differs.

I ran the loop four times and only the first round gave a gain. In round 2, none of the
seven new networks went above 46.8% against their teacher, and rounds 3 and 4 did not do
better. My reading is that the first round is the only one where the training data
changes kind, from a hand-written heuristic to a search. After that the teacher is already
a search, and it would need more compute to keep improving.

### Comparing two versions

At first I compared versions with a plain win rate over a few hundred games. Several gains
of about 5 points went away when I ran them again with new seeds, so since August every
comparison is played in pairs. Each deal (same decks, same seed) is played twice with the
sides swapped, and only the pairs where the same version won both games count. A deal that
favors one deck then counts the same for both sides. Two identical agents give exactly
50%. The p values below come from a McNemar test on these pairs, and
[`method.md`](method.md) has the details.

### Search

| Version A against version B | Pairs won by A | Pairs won by B | p |
|---|---:|---:|---:|
| 160 simulations against 80 | 72 | 36 | 0.0007 |
| 4 worlds × 200 simulations against 2 × 80 | 34 | 19 | 0.053 |
| hand-written rules only against the full agent | 19 | 39 | 0.012 |
| expand the best moves first | 29 | 26 | 0.79 |
| pick the root move by value instead of visits | 27 | 27 | 1.00 |
| no veto from the rules at the root | 27 | 31 | 0.69 |

The search does add something over the hand-written rules alone. More budget helps up to
about 160 simulations, and after that I am not sure. The 4 × 200 run leans that way, and so
did an older run of 720 simulations against 160, but neither is clear. The other changes
made no difference I could measure.

### Hidden information

| Version A against version B | Pairs won by A | Pairs won by B | p |
|---|---:|---:|---:|
| root rules see the real hand of the opponent, against an honest root | 34 | 17 | 0.024 |
| honest root with 4 sampled hands, against 1 | 32 | 19 | 0.092 |
| the same, again with new seeds | 40 | 16 | 0.0018 |
| 8 sampled hands against 4 | 27 | 18 | 0.23 |
| hands weighted by the action points the opponent left unused | 23 | 33 | 0.23 |

In September I found that the rules on top of the search were judging moves on a game
state that still had the real hand of the opponent in it. This hidden information leaked
into the choice of moves, so the win rates I had measured against other opponents were too
high (comparisons between two versions were still fair, since both sides had the same
leak). The honest
version loses about 6 points against the leaky one. Sampling four possible hands for the
opponent at the root, instead of one, gave a good part of it back, and this held up on new
seeds. Eight hands did no better than four.

I also tried to rule out hands that do not match what the opponent did, with the idea that
a player who ends a turn with unused action points probably had no cheap creature to play.
It made things slightly worse. My guess is that players keep cards for later more often
than this simple model assumes.

In August I had trained a value network that sees the hidden cards and the real Dofus. It
did not predict the winner any better than the normal one (about 66% of games either way),
so I think the hidden information matters more for choosing a move than for judging who
is ahead.

### What did not work so far

- a policy network used as a prior for the search loses (30% against value only);
- self-play with no anchor diverges within three iterations;
- more data with the same teacher gives no gain;
- bigger networks (64 and 96 channels) do not play better;
- sequential halving at the root, more candidate moves and other veto margins change
  nothing, or make things a bit worse.

Each of these was measured with the network, the search budget and the rule weights of
the time. I think some of them could work later, for example a bigger network trained on
games from a stronger search, or the policy prior with a much larger budget, so I keep them
on the list of things to try again when the rest of the agent changes.

What annoyed me the most were the errors in the engine. The engine is rebuilt from
scratch, so it sometimes behaves differently from the official game, and since the agent
learns from games played in this engine, I often had to train the networks again after a
fix.

I am completely new to game AI. The next goal is a bot that plays like someone who has
played the game for a week, and then to show it to Ankama.

## How it works

- Belief model. A probability over the opponent's hand and over which of their Dofus
  are real, built only from public information. On held-out decks (3 folds) its Brier
  score is 0.022, against 0.027 for a baseline that only uses deck statistics, with an
  ECE of 0.007.
- Search. Determinized MCTS. Possible worlds are sampled from the belief, UCT runs in
  each world, and the visit counts are added up.
- Value network. Used at the leaves of the search. A small residual CNN over the board
  (2 blocks, 48 channels), an MLP over global values and a linear layer over card
  vectors, about 1.7 million parameters, with a tanh output. Most of the parameters are in
  the card layer, the CNN is about 10%.
- Expert rules. On top of the search there are 27 rules, written after reviewing games
  with an experienced player. They remove moves that are clearly bad and break near ties,
  and they judge each move on four sampled hands of the opponent. Each rule has a test
  built on the game state where the problem showed up.

The engine and the agent are written in TypeScript with no runtime dependencies (about
29,000 lines without tests: 19,000 for the engine, 9,400 for the agent). Training uses
PyTorch with an ONNX export, and the browser runs the network with a small hand-written
WASM SIMD kernel.

## How the numbers were measured

- Data is split into train and test sets by game, not by position, since positions from
  the same game are strongly correlated.
- Each measurement runs on a fixed copy of the code, so it can be run again later.
- The engine is deterministic. The same state and the same seed give the same game, and in
  the largest generation run (8,000 games) no game broke this.
- Win rates come with a Wilson interval, and comparisons between two versions are played
  in pairs as described above. A new network is only accepted when the lower bound is
  above 50%, so a result like 53.8% [49.4, 58.1] counts as no improvement.

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

With the card data built locally, the full suite (2,626 tests) runs with:

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
