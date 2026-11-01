"""Explicit embedding profiles shared by indexing, scene splitting and search."""

from __future__ import annotations

import json
import logging
import math
import os
import struct

from urllib.parse import urlsplit
from collections.abc import Mapping
from dataclasses import dataclass

EMBEDDING_DIMENSIONS = 1536
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class EmbeddingConfig:
    provider: str
    model: str
    profile: str = "openai"

    @property
    def dimensions(self) -> int:
        return 768 if self.profile == "embeddinggemma2" else EMBEDDING_DIMENSIONS

    @property
    def table(self) -> str:
        return "scene_embeddings_768" if self.profile == "embeddinggemma2" else "scene_embeddings"


def embedding_diagnostic(config: EmbeddingConfig | None = None, **details) -> dict:
    return {
        "event": "embedding.validation",
        **({"provider": config.provider, "model": config.model} if config else {}),
        "expected_dimensions": config.dimensions if config else EMBEDDING_DIMENSIONS,
        **details,
    }


class EmbeddingContractError(RuntimeError):
    def __init__(self, reason: str, message: str, config: EmbeddingConfig | None = None, **details):
        super().__init__(message)
        self.reason = reason
        logger.error(json.dumps(embedding_diagnostic(config, reason=reason, **details)))


def resolve_embedding_config(environ: Mapping[str, str] | None = None) -> EmbeddingConfig:
    env = os.environ if environ is None else environ
    profile = env.get("EMBEDDING_PROFILE", "").strip() or "openai"
    if profile not in {"openai", "embeddinggemma2"}:
        raise EmbeddingContractError("EMBEDDING_CONFIG_INVALID", "EMBEDDING_PROFILE must be openai or embeddinggemma2.")
    if profile == "embeddinggemma2" and not (env.get("EMBEDDING_MODEL", "").strip() and env.get("EMBEDDING_BASE_URL", "").strip()):
        raise EmbeddingContractError("EMBEDDING_CONFIG_INVALID", "EmbeddingGemma 2 requires EMBEDDING_MODEL and a dedicated EMBEDDING_BASE_URL.")
    model = env.get("EMBEDDING_MODEL", "").strip() or "text-embedding-3-small"
    base = env.get("EMBEDDING_BASE_URL") or env.get("OPENAI_BASE_URL") or ("https://openrouter.ai/api/v1" if (env.get("OPENROUTER_API_KEY") or env.get("OPENROUTER_FEDERATION_POLICY_ID")) else "https://api.openai.com/v1")
    if urlsplit(base).hostname == "openrouter.ai" and model == "text-embedding-3-small":
        model = f"openai/{model}"
    return EmbeddingConfig("openai", model, profile)


def invalid_output(config: EmbeddingConfig) -> EmbeddingContractError:
    return EmbeddingContractError("EMBEDDING_OUTPUT_INVALID", f"Embedding response is incompatible with the {config.dimensions}-dimensional storage contract.", config)


def validate_embedding(value: object, config: EmbeddingConfig) -> list[float]:
    # pgvector stores float32: reject overflow and vectors that round to all zeros.
    try:
        valid = isinstance(value, list) and len(value) == config.dimensions and all(
            type(v) in (int, float) and math.isfinite(v) for v in value
        )
        rounded = [struct.unpack("f", struct.pack("f", v))[0] for v in value] if valid else []
        valid = valid and all(math.isfinite(v) for v in rounded) and any(v != 0 for v in rounded)
    except (OverflowError, struct.error):
        valid = False
    if not valid:
        raise EmbeddingContractError(
            "EMBEDDING_OUTPUT_INVALID", f"Embedding response is incompatible with the {config.dimensions}-dimensional storage contract.",
            config, actual_dimensions=len(value) if isinstance(value, list) else None,
        )
    return value
