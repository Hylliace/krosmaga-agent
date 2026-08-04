"""Reader for the policy f32 shards written by genPolicyData.ts.

Per shard: x.f32 (n×encLen, encode2 of the current decision state) + what.f32
(n×whatSize, soft π marginal) + where.f32 (n×51) + z.f32 (n, value label ±1) +
idx.u32 (game ordinal). x stays memory-mapped (ConcatMmap); the small targets are
loaded fully.
"""
from __future__ import annotations

import json
from dataclasses import dataclass

import numpy as np

from data import ConcatMmap, split_by_game  # reuse  # noqa: F401


@dataclass
class PolicyData:
    x: object          # ConcatMmap (n, encLen)
    what: np.ndarray   # (n, whatSize) soft targets
    where: np.ndarray  # (n, 51) soft targets
    z: np.ndarray      # (n,) value label ±1
    game: np.ndarray   # (n,) global game id
    enc_len: int
    what_size: int
    where_size: int


def _meta(prefix: str) -> dict:
    with open(prefix + ".meta.json", "r", encoding="utf-8") as f:
        return json.load(f)


def load_policy_shards(prefixes: list[str]) -> PolicyData:
    metas = [_meta(p) for p in prefixes]
    enc_len = int(metas[0]["encLen"])
    what_size = int(metas[0]["whatSize"])
    where_size = int(metas[0]["whereSize"])
    xs, whats, wheres, zs, games = [], [], [], [], []
    lengths = []
    for si, p in enumerate(prefixes):
        z = np.fromfile(p + ".z.f32", dtype="<f4")
        n = z.shape[0]
        xs.append(np.memmap(p + ".x.f32", dtype="<f4", mode="r", shape=(n, enc_len)))
        whats.append(np.fromfile(p + ".what.f32", dtype="<f4").reshape(n, what_size))
        wheres.append(np.fromfile(p + ".where.f32", dtype="<f4").reshape(n, where_size))
        zs.append(z)
        local = np.fromfile(p + ".idx.u32", dtype="<u4").astype(np.int64)
        games.append((np.int64(si) << np.int64(40)) | local)
        lengths.append(n)
    return PolicyData(
        x=ConcatMmap(xs, lengths, enc_len),
        what=np.concatenate(whats), where=np.concatenate(wheres),
        z=np.concatenate(zs), game=np.concatenate(games),
        enc_len=enc_len, what_size=what_size, where_size=where_size,
    )
