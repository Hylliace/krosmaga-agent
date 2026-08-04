"""Dataset reader for the encode2 f32 shards.

Memory-maps `<prefix>.x.f32` / `.y.f32` / `.idx.u32` for one or more shards, and
gives a train/val split by game (a whole game goes to one side, so there is no
leakage across the ~28 correlated end-of-turn rows of a game).
"""
from __future__ import annotations

import json
import glob
import os
from dataclasses import dataclass

import numpy as np

# Frozen encode2 layout constants (encode2.ts). Keep in sync with that file.
N_PLANES = 43
PLANE_ROWS = 5
PLANE_COLS = 10
PLANE_SIZE = PLANE_ROWS * PLANE_COLS  # 50
PLANES_LEN = N_PLANES * PLANE_SIZE    # 2150
N_GLOBALS = 91
N_V = 4
HEADER_LEN = PLANES_LEN + N_GLOBALS   # 2241 (planes + globals, before the V-vectors)


class ConcatMmap:
    """Row-gather over several `.x.f32` mmaps without materialising them in RAM.
    `x[idx]` reads only the requested rows from disk (OS page cache keeps the hot
    set resident), so a 250k×5725 dataset (~5.7 GB) never needs to fit in memory."""

    def __init__(self, mmaps: list[np.ndarray], lengths: list[int], enc_len: int):
        self.mmaps = mmaps
        self.offsets = np.cumsum([0] + lengths)
        self.enc_len = enc_len
        self.n = int(self.offsets[-1])

    @property
    def shape(self):
        return (self.n, self.enc_len)

    def __len__(self):
        return self.n

    def __getitem__(self, idx) -> np.ndarray:
        idx = np.asarray(idx)
        out = np.empty((len(idx), self.enc_len), dtype=np.float32)
        shard_id = np.searchsorted(self.offsets, idx, side="right") - 1
        for s in np.unique(shard_id):
            sel = shard_id == s
            out[sel] = self.mmaps[s][idx[sel] - self.offsets[s]]
        return out


@dataclass
class Shard:
    x: object          # ConcatMmap or (n, encLen) ndarray, gather via x[idx]
    y: np.ndarray      # (n,) float32 in {+1,-1}
    game: np.ndarray   # (n,) int64 global game id (shard-offset applied)
    enc_len: int
    vocab_size: int
    # v3: layout carried by the shard meta (falls back to the frozen v2
    # constants above for pre-v3 shards). model.py sizes itself from these.
    n_planes: int = N_PLANES
    n_globals: int = N_GLOBALS
    n_v: int = N_V


def _read_meta(prefix: str) -> dict:
    with open(prefix + ".meta.json", "r", encoding="utf-8") as f:
        return json.load(f)


def load_shard(prefix: str, shard_index: int) -> Shard:
    meta = _read_meta(prefix)
    enc_len = int(meta["encLen"])
    n_planes = int(meta.get("nPlanes", N_PLANES))
    n_globals = int(meta.get("nGlobals", N_GLOBALS))
    n_v = int(meta.get("nV", N_V))
    header = n_planes * PLANE_SIZE + n_globals
    vocab_size = int(meta.get("vocabSize", (enc_len - header) // n_v))
    y = np.fromfile(prefix + ".y.f32", dtype="<f4")
    n = y.shape[0]
    x = np.memmap(prefix + ".x.f32", dtype="<f4", mode="r", shape=(n, enc_len))
    local = np.fromfile(prefix + ".idx.u32", dtype="<u4").astype(np.int64)
    # Global game id: pack (shard_index, local) so games never collide across shards.
    game = (np.int64(shard_index) << np.int64(40)) | local
    return Shard(x=x, y=y, game=game, enc_len=enc_len, vocab_size=vocab_size,
                 n_planes=n_planes, n_globals=n_globals, n_v=n_v)


def load_shards(prefixes: list[str]) -> Shard:
    shards = [load_shard(p, i) for i, p in enumerate(prefixes)]
    enc_len = shards[0].enc_len
    vocab_size = shards[0].vocab_size
    for s in shards[1:]:
        if s.enc_len != enc_len:
            raise ValueError(f"encLen mismatch across shards: {s.enc_len} != {enc_len}")
        if (s.n_planes, s.n_globals, s.n_v) != (shards[0].n_planes, shards[0].n_globals, shards[0].n_v):
            raise ValueError("layout (nPlanes/nGlobals/nV) mismatch across shards — mixed v2/v3?")
    # x stays a list of mmaps gathered per-batch (never fully in RAM); y/game are
    # small enough to concatenate.
    x = ConcatMmap([s.x for s in shards], [len(s.y) for s in shards], enc_len)
    y = np.concatenate([s.y for s in shards], axis=0)
    game = np.concatenate([s.game for s in shards], axis=0)
    return Shard(x=x, y=y, game=game, enc_len=enc_len, vocab_size=vocab_size,
                 n_planes=shards[0].n_planes, n_globals=shards[0].n_globals, n_v=shards[0].n_v)


def discover_prefixes(pattern: str) -> list[str]:
    """Expand a glob over `.meta.json` files → sorted list of prefixes."""
    metas = sorted(glob.glob(pattern + ".meta.json")) or sorted(glob.glob(pattern))
    out = []
    for m in metas:
        out.append(m[:-len(".meta.json")] if m.endswith(".meta.json") else m)
    if not out:
        raise FileNotFoundError(f"no shards match {pattern}(.meta.json)")
    return out


def split_by_game(game: np.ndarray, val_frac: float, seed: int = 1):
    """Row index arrays (train, val) split by GLOBAL game id."""
    uniq = np.unique(game)
    rng = np.random.default_rng(seed)
    rng.shuffle(uniq)
    n_val = int(round(len(uniq) * val_frac))
    val_games = set(uniq[:n_val].tolist())
    mask_val = np.fromiter((g in val_games for g in game.tolist()), dtype=bool, count=len(game))
    idx = np.arange(len(game))
    return idx[~mask_val], idx[mask_val]


def slice_layout(enc_len: int, vocab_size: int):
    """Byte offsets into the flat encode2 vector (planes, globals, V-vectors)."""
    v0 = HEADER_LEN
    return {
        "planes": (0, PLANES_LEN),
        "globals": (PLANES_LEN, HEADER_LEN),
        "v_hand": (v0 + 0 * vocab_size, v0 + 1 * vocab_size),
        "v_cost": (v0 + 1 * vocab_size, v0 + 2 * vocab_size),
        "v_deck": (v0 + 2 * vocab_size, v0 + 3 * vocab_size),
        "v_belief": (v0 + 3 * vocab_size, v0 + 4 * vocab_size),
    }
