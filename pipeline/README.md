# Card data pipeline

These scripts build the card pool that the full test suite runs against, from a local
copy of the game. The data they produce is not committed.

## Configuration

All paths are set in [`paths.py`](paths.py) from two environment variables:

| Variable | Default | What it points at |
|---|---|---|
| `KROSMAGA_WORKSPACE` | `<repo>/workspace` | your extraction workspace (inputs) |
| `KROSMAGA_CARD_DATA` | `<repo>/public/data` | where the card pool is written |

The default output folder is the one `src/engine/testkit.ts` reads, so `npm run
test:full` finds the pool with no extra setup. Both defaults are in `.gitignore`.

If an input is missing, the script stops with a message that names the file and the
workspace it looked in.

## Workspace layout

```
$KROSMAGA_WORKSPACE/
  notes/
    card_bindata/              card data, one JSON file per card
    enums.json                 id ↔ name for God / SummonFamily / SummonProperty / …
    localization_fr.json       French names and descriptions (CARD_NAME_<id>, CARD_DESC_<id>)
    illustration_map_v2.json   card id → illustration asset name
    bindata/cardvariants/      evolution-level variants
    figurine_map.json          card id → board figurine asset (optional)
    card_effects_spec.json     effect specs read by merge_authored_effects.py
  extracted/
    cards/all_cards.json       raw card dump
    illustrations/             the PNG files
    card_to_model.json         card id → animation bundle (optional)
```

How you produce this workspace depends on your copy of the game and on the tool you use
to export its assets, so it is not scripted here.

## Order

```bash
export KROSMAGA_WORKSPACE=/path/to/your/extraction

python pipeline/analyze_cards.py                  # look at the structure of the raw dump
python pipeline/catalog_effect_types.py           # list the effect types it contains
python pipeline/build_card_pool.py Iop Cra ...    # → $KROSMAGA_CARD_DATA/cards_<god>.json
python pipeline/build_effects_spec.py             # build the effect spec from the card text
python pipeline/merge_authored_effects.py         # add the hand-written effects
```

`merge_authored_effects.py` can be run as many times as needed: each run first removes
the effects it added the time before, then adds them again with the current rules.

## `extractor.py`

Separate from the card pool: it reads a public decklist from the krosmaga.tools API and
prints the card ids and the number of copies. Needs `requests`.

```bash
python pipeline/extractor.py <deck-url-or-uuid> --out deck.json
```
