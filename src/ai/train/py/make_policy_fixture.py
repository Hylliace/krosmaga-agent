"""Tiny random PolicyNet, committed as the parity fixture for TsPolicyModel."""
from __future__ import annotations

import os

import numpy as np
import torch

from policy_model import PolicyNet
from data import PLANES_LEN, N_GLOBALS
from export_policy import export_policy

OUT_DIR = os.path.join(os.path.dirname(__file__), "../../net/__fixtures__")


def main():
    torch.manual_seed(11)
    vocab = 3
    what_size, where_size = vocab + 1 + 4, 51
    enc_len = PLANES_LEN + N_GLOBALS + 4 * vocab
    model = PolicyNet(enc_len, vocab, what_size, where_size, channels=4, blocks=1)
    with torch.no_grad():
        for p in model.parameters():
            p.copy_(torch.randn_like(p) * 0.4)
        for m in model.modules():
            if isinstance(m, torch.nn.BatchNorm2d):
                m.running_mean.copy_(torch.randn_like(m.running_mean) * 0.3)
                m.running_var.copy_(torch.rand_like(m.running_var) * 0.5 + 0.5)
    model.eval()
    ref_inputs = np.random.default_rng(2).standard_normal((8, enc_len)).astype("<f4")
    os.makedirs(OUT_DIR, exist_ok=True)
    export_policy(model, os.path.join(OUT_DIR, "tiny_policy"), ref_inputs)


if __name__ == "__main__":
    main()
