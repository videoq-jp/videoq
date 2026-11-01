"""Embedding batches and tokenizer selection for Otsu scene splitting."""

from __future__ import annotations

import logging

import numpy as np
import tiktoken

from worker_python.pipeline.embedding_contract import resolve_embedding_config
from worker_python.pipeline.embeddings import embed_texts

logger = logging.getLogger(__name__)


class SceneEmbedder:
    def __init__(self, batch_size: int = 16):
        self.batch_size = batch_size
        self.encoding = _resolve_encoding()

    def get_embeddings(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, 0), dtype=np.float64)
        if self.batch_size <= 0:
            raise ValueError("batch_size must be positive")
        # embed_texts validates row counts and dimensions. Fill the output directly
        # instead of retaining every batch plus a second full array for vstack.
        embeddings = np.empty((len(texts), resolve_embedding_config().dimensions), dtype=np.float64)
        for i in range(0, len(texts), self.batch_size):
            batch = texts[i : i + self.batch_size]
            embeddings[i : i + len(batch)] = embed_texts(batch)
        return embeddings


def _resolve_encoding() -> tiktoken.Encoding:
    config = resolve_embedding_config()
    model = config.model
    if config.provider == "openai":
        try:
            return tiktoken.encoding_for_model(model)
        except KeyError:
            logger.info("tiktoken has no encoding for %s; using cl100k_base", model)
    return tiktoken.get_encoding("cl100k_base")
