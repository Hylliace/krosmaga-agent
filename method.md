# Method

More details on how the comparisons in the README were run.

## Paired games

Every comparison between two versions of the agent is a series of deals. A deal is a pair
of decks, a seed and a first player. Each deal is played twice, once with version A in the
first seat and once with version B in it. The seed decides the shuffles, the Dofus layout
and every other random event, so both games of a pair start from the same situation.

Most pairs are split, one win for each version. These pairs only say that the deal favored
one deck, so they are left out. What is left are the pairs where the same version won both
games, and the question is whether one version wins more of them. With n such pairs and k
of them won by A, the p value is a two-sided binomial test of k out of n with a probability
of one half (this is McNemar's test on paired results).

I checked the setup by playing an agent against an exact copy of itself. It gave exactly
50%, with every pair split, so the pairing adds no bias of its own.

A series usually has 280 games (140 deals), split into a few shards that run in parallel
with different seeds. Before a series starts I write down the threshold (p below 0.05) and
I only read the result once, at the end. When a result is close to the threshold, I run the
same comparison again on new seeds before changing anything. This is what happened with the
four sampled hands, 0.092 the first time and 0.0018 the second.

## Budgets

Both versions use the same value network (value5) and the same budget unless the budget is
what is being compared. The default for these runs is 2 sampled worlds and 80 simulations
per decision, with at most 12 candidate moves at the root. Budgets are counted in
simulations, never in seconds, so the speed of the machine does not change the result.

## The root rules and the opponent hand

The search runs in worlds sampled from the belief model, so it never sees the real hand
of the opponent. The hand-written rules at the root, which remove clearly bad moves and
break near ties, used to score each move on a copy of the real game state where only the
Dofus were hidden. Their short rollouts let the opponent play its turn, with the cards of
its real hand.

The honest version samples the opponent hand from the belief model instead, the same way
the search does. With one sampled hand the scores are noisy, so the current version
samples four hands and averages the scores. The sampling is fixed for a given game state,
so the same decision always sees the same four hands.

## Weighting hands by the last turn

This is the version that did not work. At the start of my turn, the action points the
opponent did not spend in its last turn are known. For each sampled hand, every card it
contains that could have been played with these points, and was not, makes the hand less
likely. The weight is multiplied by 0.35 for a creature and 0.6 for a spell. Four times
more hands than needed are sampled, and the hands that are kept are drawn in proportion to
their weights.

## Games against the AI of the game

The 50 games against the AI that comes with the game were played in a row, on the official
servers, with one deck and with settings that did not change during the series. The way to
count was fixed before the first game. Every game started after that point counts, and a
game lost because of a crash or a closed client would have counted as a loss. No game had to
be left out. I only read the result after the 50th game. The interval in the README is a
Wilson interval at 95%.
