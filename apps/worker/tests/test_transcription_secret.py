import base64
from unittest.mock import MagicMock
from contextlib import nullcontext

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from worker_python.tasks import transcription


def _base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def test_load_searchapi_key_reads_and_decrypts_encrypted_column(monkeypatch) -> None:
    key = bytes(range(32))
    nonce = bytes(range(12))
    encrypted = AESGCM(key).encrypt(nonce, b"search-api-key", None)
    envelope = f"v1.{_base64url(nonce)}.{_base64url(encrypted)}"

    class Connection:
        query = ""
        params: tuple[int, ...] = ()

        def execute(self, query: str, params: tuple[int, ...]):
            self.query = query
            self.params = params
            return self

        def fetchone(self):
            return {"searchapi_api_key_encrypted": envelope}

    connection = Connection()
    monkeypatch.delenv("TRANSCRIPTAPI_API_KEY", raising=False)
    monkeypatch.setenv("USER_SECRET_ENCRYPTION_KEY", _base64url(key))
    monkeypatch.setattr(
        transcription, "db_connection", lambda: nullcontext(connection)
    )

    assert transcription._load_searchapi_key(7) == "search-api-key"
    assert "SELECT searchapi_api_key_encrypted FROM users" in connection.query
    assert connection.params == (7,)


def test_transcriptapi_environment_key_overrides_saved_key(monkeypatch):
    monkeypatch.setenv("TRANSCRIPTAPI_API_KEY", "transcript-key")
    monkeypatch.setenv("SEARCHAPI_API_KEY", "old-key")
    connection = MagicMock()
    monkeypatch.setattr(transcription, "db_connection", connection)
    assert transcription._load_searchapi_key("owner") == "transcript-key"
    connection.assert_not_called()
