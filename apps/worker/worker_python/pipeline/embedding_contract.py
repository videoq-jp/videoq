"""Explicit embedding profiles shared by indexing, scene splitting and search."""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import struct

from collections.abc import Mapping
from dataclasses import dataclass

EMBEDDING_DIMENSIONS = 1536
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class EmbeddingConfig:
    provider: str
    model: str
    profile: str = "openai"
    revision: str = "provider-managed"
    preprocessing: str = "raw-text-v1"

    @property
    def fingerprint(self) -> str:
        gemma = self.profile == "embeddinggemma2"
        identity = ["videoq-embedding-v1", self.provider, self.model, self.revision, self.profile, self.dimensions,
                    "task: search result | query: " if gemma else "", "title: none | text: " if gemma else "",
                    self.preprocessing, "float32-nonzero-v1", "preserve-newlines"]
        return hashlib.sha256(json.dumps(identity, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()

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
    revision = env.get("EMBEDDING_REVISION", "").strip() or "provider-managed"
    preprocessing = env.get("EMBEDDING_PREPROCESSING", "").strip() or "raw-text-v1"
    profile = env.get("EMBEDDING_PROFILE", "").strip() or "openai"
    if profile not in {"openai", "embeddinggemma2"}:
        raise EmbeddingContractError("EMBEDDING_CONFIG_INVALID", "EMBEDDING_PROFILE must be openai or embeddinggemma2.")
    provider = env.get("EMBEDDING_PROVIDER", "").strip() or "openai"
    if provider not in {"openai", "workers-ai"}:
        raise EmbeddingContractError("EMBEDDING_CONFIG_INVALID", "EMBEDDING_PROVIDER must be openai or workers-ai.")
    if provider == "workers-ai":
        model = env.get("EMBEDDING_MODEL", "").strip() or "@cf/google/embeddinggemma-2"
        if profile != "embeddinggemma2" or model != "@cf/google/embeddinggemma-2":
            raise EmbeddingContractError("EMBEDDING_CONFIG_INVALID", "Workers AI embeddings require the embeddinggemma2 profile and @cf/google/embeddinggemma-2 model.")
        return EmbeddingConfig(provider, model, profile, revision, preprocessing)
    if profile == "embeddinggemma2" and not (env.get("EMBEDDING_MODEL", "").strip() and env.get("EMBEDDING_BASE_URL", "").strip()):
        raise EmbeddingContractError("EMBEDDING_CONFIG_INVALID", "EmbeddingGemma 2 requires EMBEDDING_MODEL and a dedicated EMBEDDING_BASE_URL.")
    model = env.get("EMBEDDING_MODEL", "").strip() or "text-embedding-3-small"
    return EmbeddingConfig("openai", model, profile, revision, preprocessing)


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
