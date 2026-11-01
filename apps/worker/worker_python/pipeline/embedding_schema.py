"""Check declared dimensions, including on an empty table; never change DDL."""

from __future__ import annotations

import json
import logging

from worker_python.db import db_connection
from .embedding_contract import (
    EmbeddingConfig,
    EmbeddingContractError,
    embedding_diagnostic,
    resolve_embedding_config,
)

logger = logging.getLogger(__name__)

EMBEDDING_SCHEMA_SQL = """
    SELECT t.typname AS type_name, a.atttypmod AS dimensions
      FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
     WHERE a.attrelid = to_regclass(%s) AND a.attname = 'embedding'
       AND a.attnum > 0 AND NOT a.attisdropped
"""


def assert_embedding_schema(conn, config: EmbeddingConfig) -> None:
    row = conn.execute(EMBEDDING_SCHEMA_SQL, (f"public.{config.table}",)).fetchone()
    dimensions = row["dimensions"] if row else None
    if not row or row["type_name"] != "vector" or dimensions != config.dimensions:
        raise EmbeddingContractError(
            "EMBEDDING_SCHEMA_MISMATCH", f"Embedding storage must use vector({config.dimensions}). Check the database schema.",
            config, db_dimensions=dimensions,
        )
    logger.info(json.dumps(embedding_diagnostic(config, db_dimensions=dimensions)))


def check_embedding_storage() -> None:
    config = resolve_embedding_config()
    with db_connection() as conn:
        assert_embedding_schema(conn, config)
