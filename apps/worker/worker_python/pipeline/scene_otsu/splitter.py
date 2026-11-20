"""VideoQ multi-dimensional Otsu scene splitter."""

from __future__ import annotations

import logging

import numpy as np

from .embedders import SceneEmbedder
from worker_python.use_cases.scene_splitting import SceneSplittingPolicy

logger = logging.getLogger(__name__)


def l2_normalize(embeddings: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    norms = np.maximum(norms, 1e-12)
    return embeddings / norms


class SceneSplitter:
    """
    Splits SRT cues into semantic scenes by maximizing
    between-class variance of (L2-normalized) embeddings.
    """

    def __init__(self, batch_size: int = 16, embedder: SceneEmbedder | None = None):
        self.embedder = embedder or SceneEmbedder(batch_size=batch_size)

    def _find_otsu_threshold(self, embeddings: np.ndarray) -> int:
        t = len(embeddings)
        if t < 2:
            return 0

        # Preserve input-precision accumulation; float64 results need no second array.
        cumulative_sum = np.cumsum(embeddings, axis=0).astype(np.float64, copy=False)
        total_sum = cumulative_sum[-1]

        max_criterion = -1.0
        best_tau = 1

        for tau in range(1, t):
            n0 = tau
            n1 = t - tau
            s0 = cumulative_sum[tau - 1]
            diff = s0 * t - n0 * total_sum
            criterion = float(np.sum(diff * diff) / (n0 * n1))
            if criterion > max_criterion:
                max_criterion = criterion
                best_tau = tau

        return best_tau

    def _policy(self):
        return SceneSplittingPolicy(
            self.embedder.encoding,
            lambda texts: l2_normalize(self.embedder.get_embeddings(texts)),
            lambda vectors, start, end: self._find_otsu_threshold(vectors[start : end + 1]),
            log=logger.info,
        )

    def _split_long_text(self, encoded, start_timestamp, end_timestamp, max_tokens):
        return self._policy()._split_long_text(encoded, start_timestamp, end_timestamp, max_tokens)

    def process(self, srt_string: str, max_tokens: int = 512) -> str:
        return self._policy().process(srt_string, max_tokens=max_tokens)
