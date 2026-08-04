"""Policy net. Same trunk as the value net (conv-residual planes + MLP globals +
linear V), but with two factored heads: what_logits (card/action) and
where_logits (target cell). Kept as a separate net (its own state_dict) so the
value net checkpoint still loads; the MCTS uses the value net at the leaves and
this net as the action prior.
"""
from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F

from data import N_PLANES, PLANE_ROWS, PLANE_COLS, PLANES_LEN, N_GLOBALS, HEADER_LEN, N_V
from model import ResBlock


class PolicyNet(nn.Module):
    def __init__(self, enc_len: int, vocab_size: int, what_size: int, where_size: int = 51,
                 channels: int = 48, blocks: int = 2, dropout: float = 0.4):
        super().__init__()
        self.enc_len = enc_len
        self.vocab_size = vocab_size
        self.what_size = what_size
        self.where_size = where_size
        self.v_len = N_V * vocab_size

        self.stem = nn.Sequential(nn.Conv2d(N_PLANES, channels, 3, padding=1, bias=False),
                                  nn.BatchNorm2d(channels), nn.ReLU(inplace=True))
        self.tower = nn.Sequential(*[ResBlock(channels) for _ in range(blocks)])
        self.plane_fc = nn.Linear(channels * PLANE_ROWS * PLANE_COLS, 96)
        self.glob = nn.Sequential(nn.Linear(N_GLOBALS, 48), nn.ReLU(inplace=True),
                                  nn.Linear(48, 48), nn.ReLU(inplace=True))
        self.v_drop = nn.Dropout(min(0.6, dropout + 0.2))
        self.vfc = nn.Linear(self.v_len, 128)
        self.trunk = nn.Sequential(
            nn.Linear(96 + 48 + 128, 160), nn.ReLU(inplace=True), nn.Dropout(dropout),
            nn.Linear(160, 128), nn.ReLU(inplace=True), nn.Dropout(dropout))
        self.what_head = nn.Linear(128, what_size)
        self.where_head = nn.Linear(128, where_size)

    def trunk_feats(self, x: torch.Tensor) -> torch.Tensor:
        planes = x[:, :PLANES_LEN].reshape(-1, N_PLANES, PLANE_ROWS, PLANE_COLS)
        globals_ = x[:, PLANES_LEN:HEADER_LEN]
        v = x[:, HEADER_LEN:HEADER_LEN + self.v_len]
        p = self.plane_fc(self.tower(self.stem(planes)).flatten(1))
        g = self.glob(globals_)
        vv = self.vfc(self.v_drop(v))
        return self.trunk(torch.cat([F.relu(p), g, F.relu(vv)], dim=1))

    def forward(self, x: torch.Tensor):
        h = self.trunk_feats(x)
        return self.what_head(h), self.where_head(h)  # logits


def count_params(m: nn.Module) -> int:
    return sum(p.numel() for p in m.parameters())
