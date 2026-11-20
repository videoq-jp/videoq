"""Token-bounded scene construction with injected tokenizer and numerical kernel."""
from __future__ import annotations

import logging
from typing import Callable, Generic, Protocol, TypeVar
from worker_python.domain.srt import format_srt_time, parse_srt_scenes, parse_srt_timestamp
from worker_python.domain.scenes import SceneSegment, scenes_to_srt_string

logger = logging.getLogger(__name__)
Matrix = TypeVar("Matrix")


def split_scenes_best_effort(
    original: str, process: Callable[[], str], fatal: Callable[[Exception], bool], report_fallback: Callable[[], None],
) -> str:
    try:
        return process()
    except Exception as error:
        if fatal(error):
            raise
        report_fallback()
        return original


class SceneEncoding(Protocol):
    def encode_ordinary(self, text: str) -> list[int]: ...
    def decode(self, tokens: list[int], *, errors: str) -> str: ...


class SceneSplittingPolicy(Generic[Matrix]):
    def __init__(self, encoding: SceneEncoding, vectors: Callable[[list[str]], Matrix],
                 boundary: Callable[[Matrix, int, int], int], log: Callable[..., None] = logger.info):
        self.encoding = encoding
        self.vectors = vectors
        self.boundary = boundary
        self.log = log

    def _split_long_text(
        self, encoded: list[int], start_timestamp: str, end_timestamp: str, max_tokens: int
    ) -> list[SceneSegment]:
        total_tokens = len(encoded)
        start_sec = parse_srt_timestamp(start_timestamp)
        duration = parse_srt_timestamp(end_timestamp) - start_sec

        scenes: list[SceneSegment] = []
        chunk_start = 0
        while chunk_start < total_tokens:
            chunk_end = min(chunk_start + max_tokens, total_tokens)
            while chunk_end > chunk_start:
                try:
                    chunk_text = self.encoding.decode(
                        encoded[chunk_start:chunk_end], errors="strict"
                    )
                    # SRT reads strip outer whitespace. Removing a leading space
                    # can expand a BPE token into several tokens in the saved text.
                    if len(self.encoding.encode_ordinary(chunk_text.strip())) <= max_tokens:
                        break
                except UnicodeDecodeError:
                    # Token boundaries can fall inside a UTF-8 character.
                    pass
                chunk_end -= 1
            else:
                raise ValueError("max_tokens is too small to preserve this text")

            chunk_start_sec = start_sec + duration * (chunk_start / total_tokens)
            chunk_end_sec = start_sec + duration * (chunk_end / total_tokens)

            scenes.append(
                SceneSegment(
                    start_time=format_srt_time(chunk_start_sec),
                    end_time=format_srt_time(chunk_end_sec),
                    subtitles=[chunk_text],
                )
            )
            chunk_start = chunk_end
        return scenes

    def process(self, srt_string: str, max_tokens: int = 512) -> str:
        if max_tokens <= 0:
            raise ValueError("max_tokens must be positive")
        raw_subs = parse_srt_scenes(srt_string)
        if not raw_subs:
            self.log("Scene splitting skipped: no valid subtitle cues")
            return ""

        texts = [" ".join(cue.text.splitlines()) for cue in raw_subs]

        token_prefix = [0]
        long_text_scenes: dict[int, list[SceneSegment]] = {}
        for index, text in enumerate(texts):
            # Captions are literal text, including strings such as <|endoftext|>.
            encoded = self.encoding.encode_ordinary(text)
            token_prefix.append(token_prefix[-1] + len(encoded))
            if len(encoded) > max_tokens:
                long_text_scenes[index] = self._split_long_text(
                    encoded, raw_subs[index].start_time, raw_subs[index].end_time, max_tokens
                )
        del encoded
        embeddings: Matrix | None = None
        scenes: list[SceneSegment] = []
        pending = [(0, len(texts) - 1)]
        while pending:
            start, end = pending.pop()
            range_tokens = token_prefix[end + 1] - token_prefix[start]
            if start == end and range_tokens > max_tokens:
                scenes.extend(long_text_scenes.pop(start))
                continue
            # Joining cues adds spaces and can change token boundaries. Check
            # the actual merged text before admitting a scene to the output.
            if range_tokens <= max_tokens and (
                start == end
                or len(self.encoding.encode_ordinary(" ".join(texts[start : end + 1]))) <= max_tokens
            ):
                scenes.append(
                    SceneSegment(
                        start_time=raw_subs[start].start_time,
                        end_time=raw_subs[end].end_time,
                        subtitles=texts[start : end + 1],
                    )
                )
                continue

            if end == start + 1:
                # Two over-budget cues have only one possible boundary.
                split_idx = end
            else:
                if embeddings is None:
                    embeddings = self.vectors(texts)
                split_idx = start + self.boundary(embeddings, start, end)
            # Process the left range first without recursion or merging lists.
            pending.append((split_idx, end))
            pending.append((start, split_idx - 1))
        result = scenes_to_srt_string(scenes)
        # Whitespace-only token chunks do not form valid SRT cues.
        scene_count = sum(any(text.strip() for text in scene.subtitles) for scene in scenes)
        self.log(
            "Scene splitting completed. Original: %s segments, Scenes: %s",
            len(raw_subs),
            scene_count,
        )
        return result
