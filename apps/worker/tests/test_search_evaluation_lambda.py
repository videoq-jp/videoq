import json
import os
from pathlib import Path
import subprocess
import sys
from unittest.mock import Mock

import pytest

from worker_python import search_evaluation, search_evaluation_lambda as runtime


@pytest.fixture
def runtime_request(monkeypatch, tmp_path):
    for name in list(os.environ):
        if name.startswith(("EMBEDDING_", "OPENAI_", "OPENROUTER_", "AWS_", "VIDEOQ_SEARCH_EVALUATION_")):
            monkeypatch.delenv(name)
    monkeypatch.setenv("VIDEOQ_SEARCH_EVALUATION_ENABLED", "true")
    monkeypatch.setenv("OPENROUTER_FEDERATION_POLICY_ID", "synthetic-existing-policy")
    monkeypatch.setenv("AWS_REGION", "ap-northeast-1")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://openrouter.ai/api/v1")
    monkeypatch.setenv("EMBEDDING_MODEL", "openai/text-embedding-3-small")
    # Any attempted bootstrap/DB call is a test failure, including inherited
    # production parameter names. The runtime must not import these modules.
    monkeypatch.setenv("DB_PARAM_NAME", "/synthetic/forbidden-db")
    monkeypatch.setenv("APP_PARAM_NAME", "/synthetic/forbidden-app")
    monkeypatch.setattr(runtime.tempfile, "tempdir", str(tmp_path))
    event = {"version": 1, "operation": "prepare_query_embeddings", "manifest": {
        "version": 1, "cohort": "production-rehearsal", "corpusSha256": "a" * 64,
        "embedding": {"provider": "openai", "profile": "openai", "model": "openai/text-embedding-3-small",
                      "dimensions": 1536, "baseUrl": "https://openrouter.ai/api/v1", "authentication": "workload-federation"},
        "samples": 1, "cases": [{"id": "q1", "question": "私有の合成質問 🌸", "userId": "owner", "videoIds": [1], "limit": 20}],
    }}
    provider = Mock(side_effect=lambda texts, **_: [[1.0] + [0.0] * 1535 for _ in texts])
    monkeypatch.setattr(search_evaluation, "embed_texts", provider)
    context = Mock()
    context.get_remaining_time_in_millis.return_value = 300000
    return event, context, provider, tmp_path


def test_explicit_runtime_uses_existing_configuration_and_returns_only_private_vectors(runtime_request, capsys):
    event, context, provider, temporary = runtime_request
    before = dict(os.environ)
    response = runtime.handler(event, context)
    assert response["status"] == "complete"
    assert response["quality_evaluated"] is False
    assert response["evaluation_input"]["cases"][0]["queryEmbedding"] == [1.0] + [0.0] * 1535
    assert response["evaluation_input"]["generation"]["case_ids"] == ["q1"]
    assert "私有の合成質問" not in json.dumps(response, ensure_ascii=False)
    assert len(response["manifest_sha256"]) == 64
    provider.assert_called_once_with(["私有の合成質問 🌸"], input_type="query")
    assert dict(os.environ) == before
    assert list(temporary.iterdir()) == []
    captured = capsys.readouterr()
    assert captured.out == captured.err == ""


@pytest.mark.parametrize("value", [None, "false", "TRUE", "1"])
def test_default_disabled_rejects_without_calls(runtime_request, monkeypatch, value):
    event, context, provider, temporary = runtime_request
    if value is None:
        monkeypatch.delenv("VIDEOQ_SEARCH_EVALUATION_ENABLED")
    else:
        monkeypatch.setenv("VIDEOQ_SEARCH_EVALUATION_ENABLED", value)
    assert runtime.handler(event, context)["code"] == "evaluation_disabled"
    provider.assert_not_called()
    assert list(temporary.iterdir()) == []


@pytest.mark.parametrize("change", [
    lambda x: x.update(Records=[]),
    lambda x: x.update(command="run SQL"),
    lambda x: x.update(version=True),
    lambda x: x.update(operation="index_video_transcript"),
    lambda x: x["manifest"]["embedding"].update(authentication="configured"),
    lambda x: x["manifest"]["embedding"].update(model="unreviewed-model"),
    lambda x: x["manifest"]["cases"][0].update(question=""),
])
def test_invalid_inputs_and_overrides_never_reach_provider(runtime_request, change):
    event, context, provider, temporary = runtime_request
    change(event)
    assert runtime.handler(event, context)["status"] == "failed"
    provider.assert_not_called()
    assert list(temporary.iterdir()) == []


def test_input_and_context_limits_are_checked_before_model_calls(runtime_request):
    event, context, provider, _ = runtime_request
    context.get_remaining_time_in_millis.return_value = 239999
    assert runtime.handler(event, context)["code"] == "insufficient_execution_time"
    context.get_remaining_time_in_millis.return_value = 300000
    event["manifest"]["cases"] = [{**event["manifest"]["cases"][0], "id": f"q{i}"} for i in range(17)]
    assert runtime.handler(event, context)["code"] == "too_many_cases"
    provider.assert_not_called()


def test_faults_return_sanitized_failure_and_remove_question_files(runtime_request, capsys):
    event, context, provider, temporary = runtime_request
    provider.side_effect = RuntimeError("SDK echoed private-token and private-question")
    response = runtime.handler(event, context)
    assert response["code"] == "embedding_failed"
    assert "private-token" not in json.dumps(response)
    assert "private-question" not in json.dumps(response)
    assert list(temporary.iterdir()) == []
    captured = capsys.readouterr()
    assert captured.out == captured.err == ""


def test_runtime_import_cannot_load_database_secret_bootstrap_or_queue(runtime_request):
    event, _, _, _ = runtime_request
    script = '''import importlib.abc,json,os,sys
class Block(importlib.abc.MetaPathFinder):
 def find_spec(self,fullname,path=None,target=None):
  if fullname in ['psycopg','boto3','worker_python.db','worker_python.secrets_bootstrap','worker_python.sqs_enqueue','worker_python.lambda_handler','worker_python.job_execution']:
   raise AssertionError('Forbidden evaluation import')
sys.meta_path.insert(0,Block())
from worker_python.search_evaluation_lambda import handler
assert handler({},None)['code']=='evaluation_disabled'
from worker_python import search_evaluation
search_evaluation.embed_texts=lambda texts,**_: [[1.0]+[0.0]*1535 for _ in texts]
os.environ['VIDEOQ_SEARCH_EVALUATION_ENABLED']='true'
class Context:
 def get_remaining_time_in_millis(self): return 300000
assert handler(json.load(sys.stdin),Context())['status']=='complete'
'''
    env = {key: value for key, value in os.environ.items() if key != "VIDEOQ_SEARCH_EVALUATION_ENABLED"}
    result = subprocess.run([sys.executable, "-c", script], cwd=Path(__file__).resolve().parents[1], env=env, input=json.dumps(event), text=True, capture_output=True)
    assert result.returncode == 0, result.stderr
    assert result.stdout == result.stderr == ""


def test_oversized_request_is_refused_before_provider_calls(runtime_request):
    event, context, provider, temporary = runtime_request
    event["manifest"]["cases"][0]["question"] = "x" * (runtime.MAX_REQUEST_BYTES + 1)
    assert runtime.handler(event, context)["code"] == "invalid_request"
    provider.assert_not_called()
    assert list(temporary.iterdir()) == []


def test_response_limit_leaves_no_payload_or_temporary_files(runtime_request, monkeypatch):
    event, context, _, temporary = runtime_request
    monkeypatch.setattr(runtime, "MAX_RESPONSE_BYTES", 1)
    response = runtime.handler(event, context)
    assert response["code"] == "response_too_large"
    assert "evaluation_input" not in response
    assert list(temporary.iterdir()) == []


def test_unexpected_failures_are_not_logged_or_returned(runtime_request, monkeypatch, capsys):
    event, context, _, temporary = runtime_request
    monkeypatch.setattr(runtime, "prepare", Mock(side_effect=RuntimeError("DB_URL=private secret request")))
    assert runtime.handler(event, context)["code"] == "evaluation_failed"
    assert list(temporary.iterdir()) == []
    assert capsys.readouterr().err == ""
