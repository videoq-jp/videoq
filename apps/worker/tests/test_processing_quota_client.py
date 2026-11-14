from unittest.mock import MagicMock

import pytest

from worker_python import processing_quota as quota


def test_d1_reservation_uses_only_internal_api(monkeypatch):
    monkeypatch.setenv("PERSISTENCE_BACKEND", "d1")
    db = MagicMock(side_effect=AssertionError("PostgreSQL must not be used"))
    monkeypatch.setattr(quota, "db_connection", db)
    api = MagicMock(return_value={"allowed": False, "limitSeconds": 60})
    monkeypatch.setattr(quota, "call_internal_api", api)
    result = quota.reserve_video_processing(10, 30)
    assert result.allowed is False and result.limit_seconds == 60
    api.assert_called_once_with("processing/reserve", {"videoId": 10, "seconds": 30})
    for response in ({"allowed": 1}, {"allowed": True, "limitSeconds": -1}):
        api.return_value = response
        with pytest.raises(RuntimeError, match="Invalid processing quota response"):
            quota.reserve_video_processing(10, 30)
    db.assert_not_called()
