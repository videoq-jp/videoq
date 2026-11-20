"""VideoQ Otsu-based scene splitting."""

from __future__ import annotations

import logging
from ..embedding_contract import EmbeddingContractError

from .embedders import SceneEmbedder
from .parsers import scenes_to_srt_string
from .splitter import SceneSplitter, l2_normalize
from .types import SceneSegment
from worker_python.use_cases.scene_splitting import split_scenes_best_effort

logger = logging.getLogger(__name__)

__all__ = [
    "SceneEmbedder",
    "SceneSegment",
    "SceneSplitter",
    "apply_scene_splitting",
    "l2_normalize",
    "scenes_to_srt_string",
]


def apply_scene_splitting(
    srt_content: str,
    *,
    max_tokens: int = 512,
) -> str:
    """
    Apply Otsu scene splitting. Embedding contract errors fail the job;
    other failures return the original SRT as a best-effort fallback.
    """
    return split_scenes_best_effort(
        srt_content, lambda: SceneSplitter().process(srt_content, max_tokens=max_tokens),
        lambda error: isinstance(error, EmbeddingContractError),
        lambda: logger.warning("Scene splitting failed. Using original SRT content."),
    )
