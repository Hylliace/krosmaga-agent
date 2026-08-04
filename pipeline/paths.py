"""Filesystem layout for the extraction pipeline.

Every path the pipeline reads or writes is resolved here, from the environment.
Set `KROSMAGA_WORKSPACE` to the directory holding your own extraction; the
defaults below keep everything inside the repository, where .gitignore already
excludes it.

See pipeline/README.md for what each input is and how it is produced.
"""
import os
from pathlib import Path

# pipeline/ sits directly under the repository root.
REPO = Path(__file__).resolve().parent.parent

# Everything derived from a local installation of the game lives under the
# workspace. Nothing under it is ever committed.
WORKSPACE = Path(os.environ.get("KROSMAGA_WORKSPACE", REPO / "workspace")).resolve()

NOTES = WORKSPACE / "notes"          # intermediate tables (enums, localization, bindata dumps)
EXTRACTED = WORKSPACE / "extracted"  # raw asset extraction (illustrations, card dumps)

# Where the built card pool lands. This is the directory `src/engine/testkit.ts`
# reads, so `npm run test:full` picks it up with no further configuration.
CARD_DATA = Path(os.environ.get("KROSMAGA_CARD_DATA", REPO / "public" / "data")).resolve()
ILLUSTRATIONS = Path(os.environ.get("KROSMAGA_ILLUSTRATIONS", REPO / "public" / "illustrations")).resolve()

# The per-god card files the later stages read back.
CARD_POOL_GLOB = str(CARD_DATA / "cards_*.json")


def require(p: Path, what: str) -> Path:
    """Return `p`, or exit with a message that says what is missing and where."""
    if not p.exists():
        raise SystemExit(
            f"missing {what}: {p}\n"
            f"KROSMAGA_WORKSPACE is currently {WORKSPACE}.\n"
            f"See pipeline/README.md for how this input is produced."
        )
    return p
