"""Shared connection for OpenAI-compatible inference servers."""
from worker_python.env import env_str


def shared_base_url() -> str:
    return (env_str("OPENAI_BASE_URL") or "https://api.openai.com/v1").rstrip("/")


def shared_api_key() -> str:
    return env_str("OPENAI_API_KEY")
