"""Build a small random ValueNet and its reference I/O, committed as the parity
reference for the TS forward (the real model's weights are large and gitignored).

Uses the full plane(43)/global(91) structure but tiny channels/blocks/vocab so the
fixture stays small. All params are randomised, BatchNorm running stats included,
so the BN eval path is really tested (not the identity default).

  python src/ai/train/py/make_fixture.py
"""
from __future__ import annotations

import os

import numpy as np
import torch

from model import ValueNet
from data import N_PLANES, PLANES_LEN, N_GLOBALS
from export import export_model

OUT_DIR = os.path.join(os.path.dirname(__file__), "../../net/__fixtures__")


def main():
    torch.manual_seed(7)
    vocab = 3
    channels, blocks = 4, 1
    enc_len = PLANES_LEN + N_GLOBALS + 4 * vocab
    model = ValueNet(enc_len, vocab, channels=channels, blocks=blocks)

    # Randomise every parameter and BatchNorm running buffers so BN-eval is real.
    with torch.no_grad():
        for p in model.parameters():
            p.copy_(torch.randn_like(p) * 0.5)
        for m in model.modules():
            if isinstance(m, torch.nn.BatchNorm2d):
                m.running_mean.copy_(torch.randn_like(m.running_mean) * 0.3)
                m.running_var.copy_(torch.rand_like(m.running_var) * 0.5 + 0.5)  # >0
    model.eval()

    rng = np.random.default_rng(1)
    ref_inputs = rng.standard_normal((8, enc_len)).astype("<f4")

    os.makedirs(OUT_DIR, exist_ok=True)
    export_model(model, os.path.join(OUT_DIR, "tiny"), ref_inputs)


if __name__ == "__main__":
    main()
