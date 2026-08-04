"""Value net. The trunk can take several heads (only the value head is built; the
others are hooks for later). It slices the flat encode2 vector into:

  planes (43,5,10) -> conv-residual tower -> 96
  globals (91)     -> MLP -> 48
  V (4*vocab)      -> linear -> 128         (hand multihot / cost / deck / foe_belief)

concat (272) -> trunk MLP -> value head (tanh, ±1).

The ops are kept reproducible in TS (Conv2d / BN / ReLU / Linear / tanh) so the
forward can run in pure TS with |TS−ORT| < 1e-4.
"""
from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F

from data import (
    N_PLANES, PLANE_ROWS, PLANE_COLS, PLANES_LEN, N_GLOBALS, HEADER_LEN, N_V,
)


class ResBlock(nn.Module):
    def __init__(self, c: int):
        super().__init__()
        self.c1 = nn.Conv2d(c, c, 3, padding=1, bias=False)
        self.b1 = nn.BatchNorm2d(c)
        self.c2 = nn.Conv2d(c, c, 3, padding=1, bias=False)
        self.b2 = nn.BatchNorm2d(c)

    def forward(self, x):
        h = F.relu(self.b1(self.c1(x)))
        h = self.b2(self.c2(h))
        return F.relu(x + h)


class ValueNet(nn.Module):
    def __init__(self, enc_len: int, vocab_size: int, channels: int = 48, blocks: int = 2, dropout: float = 0.4,
                 n_planes: int = N_PLANES, n_globals: int = N_GLOBALS, n_v: int = N_V):
        super().__init__()
        self.enc_len = enc_len
        self.vocab_size = vocab_size
        # v3: layout comes from the shard meta (defaults = frozen v2 constants).
        self.n_planes = n_planes
        self.n_globals = n_globals
        self.n_v = n_v
        self.planes_len = n_planes * PLANE_ROWS * PLANE_COLS
        self.header_len = self.planes_len + n_globals
        self.v_len = n_v * vocab_size

        # planes tower
        self.stem = nn.Sequential(nn.Conv2d(n_planes, channels, 3, padding=1, bias=False),
                                  nn.BatchNorm2d(channels), nn.ReLU(inplace=True))
        self.tower = nn.Sequential(*[ResBlock(channels) for _ in range(blocks)])
        self.plane_fc = nn.Linear(channels * PLANE_ROWS * PLANE_COLS, 96)

        # globals MLP
        self.glob = nn.Sequential(nn.Linear(n_globals, 48), nn.ReLU(inplace=True),
                                  nn.Linear(48, 48), nn.ReLU(inplace=True))

        # V-vectors (hand/cost/deck/belief). They almost identify the game on their own
        # (my_deck_remaining ≈ deck identity), so heavy input dropout turns them into a
        # bagged feature set the net cannot memorise game by game.
        self.v_drop = nn.Dropout(min(0.6, dropout + 0.2))
        self.vfc = nn.Linear(self.v_len, 128)

        # trunk + value head (dropout between layers)
        self.trunk = nn.Sequential(
            nn.Linear(96 + 48 + 128, 128), nn.ReLU(inplace=True), nn.Dropout(dropout),
            nn.Linear(128, 96), nn.ReLU(inplace=True), nn.Dropout(dropout))
        self.value_head = nn.Linear(96, 1)

    def split(self, x: torch.Tensor):
        planes = x[:, :self.planes_len].reshape(-1, self.n_planes, PLANE_ROWS, PLANE_COLS)
        globals_ = x[:, self.planes_len:self.header_len]
        v = x[:, self.header_len:self.header_len + self.v_len]
        return planes, globals_, v

    def logit(self, x: torch.Tensor) -> torch.Tensor:
        """Pre-tanh value (unbounded). Parity is tested here (no saturation)."""
        planes, globals_, v = self.split(x)
        p = self.tower(self.stem(planes))
        p = self.plane_fc(p.flatten(1))
        g = self.glob(globals_)
        vv = self.vfc(self.v_drop(v))
        h = self.trunk(torch.cat([F.relu(p), g, F.relu(vv)], dim=1))
        return self.value_head(h).squeeze(1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return torch.tanh(self.logit(x))  # (B,) in (−1,1)


def count_params(m: nn.Module) -> int:
    return sum(p.numel() for p in m.parameters())
