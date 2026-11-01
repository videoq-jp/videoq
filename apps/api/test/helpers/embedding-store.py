"""Python half of the cross-language PGVectorStore integration test."""

import asyncio
import os
from unittest.mock import patch

from langchain_postgres import PGEngine, PGVectorStore
from langchain_postgres.v2.indexes import HNSWIndex
from sqlalchemy.engine import make_url

from worker_python.db import db_connection
from worker_python.pipeline import vector_index
from worker_python.pipeline.embedding_contract import resolve_embedding_config

config = resolve_embedding_config()
from worker_python.pipeline.langchain_embeddings import VideoQEmbeddings
from worker_python.video_sql import get_video_for_task


def embed(texts):
    return [[1.0 if i == 0 else 0.0 for i in range(config.dimensions)] for _ in texts]


with patch.object(vector_index, "embed_texts", side_effect=embed):
    for owner, video_id in [("allowed-owner", 60), ("other-owner", 61), ("allowed-owner", 62)]:
        with db_connection() as conn:
            conn.execute("""
                INSERT INTO users (id, email, username, max_video_upload_size_mb,
                    is_over_quota, used_ai_answers, used_processing_seconds, used_storage_bytes)
                VALUES (%s, %s, %s, 100, false, 0, 0, 0) ON CONFLICT (id) DO NOTHING
            """, (owner, f"{owner}@example.invalid", owner))
            conn.execute("""
                INSERT INTO videos (id, user_id, title, transcript, status, file,
                    description, uploaded_at, error_message, source_type, source_url, youtube_video_id)
                VALUES (%s, %s, %s, %s, 'completed', '', '', NOW(), '', 'uploaded', '', '')
            """, (video_id, owner, f"Video {video_id}",
                  "1\n00:00:00,000 --> 00:00:05,000\nWater evaporates when heated.\n"))
            row = get_video_for_task(conn, video_id)
        assert row is not None
        assert vector_index.index_video_transcript(row) == 1

engine = PGEngine.from_connection_string(
    url=make_url(os.environ["DATABASE_URL"]).set(drivername="postgresql+psycopg"),
)
try:
    store = PGVectorStore.create_sync(
        engine=engine, table_name=config.table, embedding_service=VideoQEmbeddings(),
        metadata_columns=["user_id", "video_id"],
    )
    store.apply_vector_index(HNSWIndex(name="python_embedding_hnsw"))
    result = store.similarity_search_by_vector(embed(["query"])[0], k=3, filter={"user_id": "allowed-owner", "video_id": 60})
    assert len(result) == 1 and result[0].metadata["video_id"] == 60
    store.drop_vector_index("python_embedding_hnsw")
finally:
    asyncio.run(engine.close())
# Pure cleanup must remain available without any usable model configuration.
os.environ.pop("EMBEDDING_API_KEY", None)
os.environ.pop("OPENAI_API_KEY", None)
assert vector_index.delete_video_vectors(61) == 1
print("python_save_search_hnsw_ok")
