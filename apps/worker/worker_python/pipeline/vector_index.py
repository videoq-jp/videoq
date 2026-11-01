"""Atomic indexing into the shared PGVectorStore-compatible scene table."""

from __future__ import annotations

import json
import logging
import uuid
from contextlib import nullcontext
from typing import Any

import psycopg
from psycopg.types.json import Json

from worker_python.db import db_connection
from worker_python.env import env_str
from worker_python.pipeline.embeddings import embed_texts
from worker_python.pipeline.embedding_contract import resolve_embedding_config
from worker_python.pipeline.embedding_schema import check_embedding_storage
from worker_python.pipeline.srt import parse_srt_scenes
from worker_python.pipeline.scene_otsu import apply_scene_splitting
from worker_python.video_sql import VideoRow

logger = logging.getLogger(__name__)

ALLOWED_TABLES = frozenset({"scene_embeddings", "scene_embeddings_768"})


def _table_name() -> str:
    expected = resolve_embedding_config().table
    name = env_str("PGVECTOR_COLLECTION_NAME", expected)
    if name not in ALLOWED_TABLES:
        raise ValueError(f"vector table '{name}' is not in the allowed list")
    if name != expected:
        raise ValueError("Vector table does not match the selected embedding profile.")
    return name


def _delete_vectors(
    metadata_key: str,
    value: int | str,
    *,
    conn: psycopg.Connection[Any] | None = None,
) -> int:
    table = _table_name()
    with nullcontext(conn) if conn is not None else db_connection() as db:
        if metadata_key not in {"video_id", "user_id"}:
            raise ValueError(f"unsupported metadata key: {metadata_key}")
        result = db.execute(
            f'DELETE FROM "{table}" WHERE "{metadata_key}" = %s',
            (value,),
        )
        return result.rowcount


def delete_video_vectors(video_id: int, *, conn: psycopg.Connection[Any] | None = None) -> int:
    deleted = _delete_vectors("video_id", video_id, conn=conn)
    logger.info("Deleted %d vector rows for video %d", deleted, video_id)
    return deleted


def delete_user_vectors(user_id: str, *, conn: psycopg.Connection[Any] | None = None) -> int:
    deleted = _delete_vectors("user_id", user_id, conn=conn)
    logger.info("Deleted %d vector rows for user %s", deleted, user_id)
    return deleted


def index_video_transcript(video: VideoRow) -> int:
    """Group original cues for search without changing the saved transcript."""
    if not video.transcript:
        raise ValueError(f"Video {video.id} has no transcript")

    scenes = parse_srt_scenes(video.transcript)
    if not scenes:
        raise ValueError(f"Video {video.id} transcript contains no valid SRT scenes")

    table = _table_name()
    check_embedding_storage()
    # The saved SRT retains original cue boundaries for playback and window reads.
    # Only searchable scenes are grouped; the race check below uses the original.
    scenes = parse_srt_scenes(apply_scene_splitting(video.transcript))
    if not scenes:
        raise ValueError(f"Video {video.id} scene splitting produced no valid SRT scenes")
    texts = [s.text for s in scenes]
    # Batch embeddings in chunks to avoid provider limits.
    embeddings: list[list[float]] = []
    batch_size = 64
    for i in range(0, len(texts), batch_size):
        embeddings.extend(embed_texts(texts[i : i + batch_size]))

    # Generate embeddings before opening the write transaction. Readers keep
    # the old scenes until every replacement row has been written successfully.
    with db_connection() as conn:
        # API edits/deletion use this same row lock, not the worker advisory
        # lock. Recheck after provider I/O before replacing any existing scenes.
        current = conn.execute(
            """
            SELECT title, transcript IS NOT DISTINCT FROM %s AS transcript_matches
              FROM videos
             WHERE id = %s AND user_id = %s
             FOR UPDATE
            """,
            (video.transcript, video.id, video.user_id),
        ).fetchone()
        if current is None:
            logger.info("Video %d was deleted during indexing; skipping", video.id)
            return 0
        if not current["transcript_matches"]:
            raise ValueError(f"Video {video.id} transcript changed during indexing; retry")

        conn.execute(f'DELETE FROM "public"."{table}" WHERE video_id = %s', (video.id,))
        with conn.cursor() as cursor:
            cursor.executemany(
                f'''INSERT INTO "public"."{table}"
                    (langchain_id, content, embedding, user_id, video_id, langchain_metadata)
                    VALUES (%s, %s, %s::vector, %s, %s, %s)''',
                (
                    (uuid.uuid4(), scene.text, json.dumps(embedding), video.user_id, video.id, Json({
                        "video_title": current["title"],
                        "start_time": scene.start_time,
                        "end_time": scene.end_time,
                        "start_sec": scene.start_sec,
                        "end_sec": scene.end_sec,
                        "scene_index": scene.index,
                    }))
                    for scene, embedding in zip(scenes, embeddings, strict=True)
                ),
            )
    inserted = len(scenes)

    logger.info("Indexed %d scenes for video %d into %s", inserted, video.id, table)
    return inserted
