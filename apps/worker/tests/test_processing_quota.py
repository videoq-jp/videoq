from __future__ import annotations

import os
from unittest.mock import MagicMock

import psycopg
import pytest
from psycopg.rows import dict_row

from worker_python.video_sql import reserve_processing_seconds


def _connection(*rows):
    conn = MagicMock()
    results = []
    for row in rows:
        cursor = MagicMock()
        cursor.fetchone.return_value = row
        results.append(cursor)
    conn.execute.side_effect = results
    return conn


def test_processing_reservation_is_idempotent_per_video() -> None:
    conn = _connection({"user_id": "u1", "processing_seconds": 30})

    result = reserve_processing_seconds(conn, 10, 30)

    assert result.allowed is True
    assert conn.execute.call_count == 1


def test_processing_reservation_uses_conditional_user_update() -> None:
    conn = _connection(
        {"user_id": "u1", "processing_seconds": 0},
        {"used_processing_seconds": 30},
        None,
    )

    result = reserve_processing_seconds(conn, 10, 30)

    assert result.allowed is True
    quota_sql = conn.execute.call_args_list[1].args[0]
    assert "processing_limit_minutes" in quota_sql
    assert "is_over_quota IS NOT TRUE" in quota_sql
    assert "RETURNING used_processing_seconds" in quota_sql


def test_processing_reservation_rejects_without_marking_video() -> None:
    conn = _connection(
        {"user_id": "u1", "processing_seconds": 0},
        None,
        {"processing_limit_minutes": 1},
    )

    result = reserve_processing_seconds(conn, 10, 61)

    assert result.allowed is False
    assert result.limit_seconds == 60
    assert conn.execute.call_count == 3


@pytest.mark.parametrize("limit,used,seconds,allowed", [
    (2_147_483_647, 0, 60, True),
    (1, 2_147_483_647, 60, False),
    (1, 30, 30, True),
    (1, 30, 31, False),
    (0, 0, 1, False),
    (None, 0, 60, True),
])
def test_processing_quota_arithmetic_on_postgres(limit, used, seconds, allowed):
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        pytest.skip("DATABASE_URL is required for PostgreSQL integration tests")
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        conn.execute("""
            CREATE TEMP TABLE users (
                id text PRIMARY KEY, processing_limit_minutes integer,
                used_processing_seconds integer, used_ai_answers integer DEFAULT 0,
                usage_period_start timestamptz DEFAULT now(),
                is_over_quota boolean DEFAULT false
            );
            CREATE TEMP TABLE videos (
                id bigint PRIMARY KEY, user_id text, processing_seconds integer DEFAULT 0
            );
            INSERT INTO videos (id, user_id) VALUES (10, 'owner');
        """)
        conn.execute("INSERT INTO users (id, processing_limit_minutes, used_processing_seconds) VALUES ('owner', %s, %s)",
                     (limit, used))

        result = reserve_processing_seconds(conn, 10, seconds)

        assert result.allowed is allowed
        if not allowed:
            assert result.limit_seconds == limit * 60
        assert conn.execute("SELECT used_processing_seconds FROM users").fetchone()["used_processing_seconds"] == (
            used + seconds if allowed else used
        )
        assert conn.execute("SELECT processing_seconds FROM videos").fetchone()["processing_seconds"] == (
            seconds if allowed else 0
        )


@pytest.mark.parametrize('period', [None, '2000-01-01T00:00:00Z'])
@pytest.mark.parametrize('blocked', [False, True])
def test_expired_usage_reset_is_atomic_and_reserved_retries_do_not_recharge(period, blocked):
    url = os.environ.get('DATABASE_URL')
    if not url:
        pytest.skip('DATABASE_URL is required for PostgreSQL integration tests')
    with psycopg.connect(url, row_factory=dict_row) as conn:
        conn.execute("""
            CREATE TEMP TABLE users (
                id text PRIMARY KEY, processing_limit_minutes integer,
                used_processing_seconds integer, used_ai_answers integer,
                usage_period_start timestamptz, is_over_quota boolean
            );
            CREATE TEMP TABLE videos (id bigint PRIMARY KEY, user_id text, processing_seconds integer DEFAULT 0);
            INSERT INTO videos(id,user_id) VALUES(10,'owner');
        """)
        conn.execute('INSERT INTO users VALUES(%s,1,999,77,%s,%s)', ('owner', period, blocked))
        assert reserve_processing_seconds(conn, 10, 60).allowed is not blocked
        state = conn.execute("""SELECT used_processing_seconds,used_ai_answers,
            date_trunc('month',usage_period_start,'UTC')=date_trunc('month',now(),'UTC') AS current_period FROM users""").fetchone()
        assert state['used_processing_seconds'] == (999 if blocked else 60)
        assert state['used_ai_answers'] == (77 if blocked else 0)
        assert bool(state['current_period']) is not blocked
        if not blocked:
            conn.execute('UPDATE users SET is_over_quota=true')
            assert reserve_processing_seconds(conn, 10, 61).allowed
            assert conn.execute('SELECT used_processing_seconds FROM users').fetchone()['used_processing_seconds'] == 60
            assert conn.execute('SELECT processing_seconds FROM videos').fetchone()['processing_seconds'] == 60
