import copy
import json
import os
from pathlib import Path
import subprocess
import sys
from unittest.mock import Mock

import pytest

from worker_python import search_evaluation as evaluation


@pytest.fixture
def inputs(tmp_path, monkeypatch):
    # Never inherit developer credentials or model overrides into these tests.
    for key in list(os.environ):
        if key.startswith(("EMBEDDING_", "OPENAI_", "OPENROUTER_", "AWS_")):
            monkeypatch.delenv(key)
    monkeypatch.setenv("EMBEDDING_MODEL", "openai/text-embedding-3-small")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://openrouter.ai/api/v1")
    monkeypatch.setenv("OPENROUTER_API_KEY", "synthetic-configured-key")
    tmp_path.chmod(0o700)
    manifest = {"version": 1, "cohort": "production-rehearsal", "corpusSha256": "a" * 64,
                "embedding": {"provider": "openai", "profile": "openai", "model": "openai/text-embedding-3-small", "dimensions": 1536,
                              "baseUrl": "https://openrouter.ai/api/v1", "authentication": "configured"},
                "samples": 2, "cases": [
                    {"id": "q1", "question": "比較の質問 🌸", "userId": "owner", "videoIds": [2, 1, 2], "limit": 20},
                    {"id": "q2", "question": "比較の質問 🌸", "userId": "peer", "videoIds": [3], "limit": 10}]}
    source, destination = tmp_path / "questions.json", tmp_path / "vectors.json"

    def save(value=None):
        source.write_text(json.dumps(manifest if value is None else value, ensure_ascii=False), encoding="utf-8")
        source.chmod(0o600)
    save()
    provider = Mock(side_effect=lambda texts, **_: [[1.0] + [0.0] * 1535 for _ in texts])
    monkeypatch.setattr(evaluation, "embed_texts", provider)
    return manifest, source, destination, save, provider


def test_preflight_makes_no_model_calls_or_files(inputs):
    _, source, destination, _, provider = inputs
    assert evaluation.prepare(source, destination) == {"status": "ready", "cases": 2, "unique_queries": 1, "dimensions": 1536, "model_calls_made": False, "execute_required": True}
    provider.assert_not_called()
    assert list(source.parent.iterdir()) == [source]


def test_reuses_query_vectors_across_scopes_and_preserves_provenance_privately(inputs):
    manifest, source, destination, _, provider = inputs
    before = dict(os.environ)
    result = evaluation.prepare(source, destination, execute=True)
    assert result["status"] == "written" and result["quality_evaluated"] is False
    provider.assert_called_once_with(["比較の質問 🌸"], input_type="query")
    data = json.loads(destination.read_text())
    assert data["model"] == manifest["embedding"]["model"]
    assert data["corpusSha256"] == manifest["corpusSha256"]
    assert data["cases"][0]["queryEmbedding"] == data["cases"][1]["queryEmbedding"]
    assert data["cases"][0]["videoIds"] == [2, 1]
    assert data["cases"][1]["userId"] == "peer"
    assert data["generation"]["case_ids"] == ["q1", "q2"]
    assert len(data["generation"]["manifest_sha256"]) == 64
    assert "比較の質問" not in destination.read_text()
    assert destination.stat().st_mode & 0o777 == 0o600
    assert set(source.parent.iterdir()) == {source, destination}
    assert dict(os.environ) == before


@pytest.mark.parametrize("change", [
    lambda x: x.update(version=True),
    lambda x: x.update(samples=True),
    lambda x: x["cases"][0].update(videoIds=[True]),
    lambda x: x["cases"][0].update(limit=0),
    lambda x: x["cases"][0].update(question=" "),
    lambda x: x["cases"][0].update(unexpected="private-token"),
    lambda x: x["cases"][1].update(id="q1"),
    lambda x: x["embedding"].update(dimensions=768),
    lambda x: x["embedding"].update(baseUrl="https://token:secret@openrouter.ai/api/v1"),
])
def test_rejects_invalid_manifests_before_model_calls(inputs, change):
    manifest, source, destination, save, provider = inputs
    change(manifest)
    save()
    with pytest.raises(evaluation.EvaluationError):
        evaluation.prepare(source, destination, execute=True)
    provider.assert_not_called()
    assert not destination.exists()


@pytest.mark.parametrize("field,value", [("model", "a-different-model"), ("baseUrl", "https://other.example/v1"), ("authentication", "workload-federation")])
def test_rejects_configuration_drift_without_changing_environment(inputs, field, value):
    manifest, source, destination, save, provider = inputs
    manifest["embedding"][field] = value
    save()
    before = dict(os.environ)
    with pytest.raises(evaluation.EvaluationError, match="configuration_mismatch"):
        evaluation.prepare(source, destination, execute=True)
    assert dict(os.environ) == before
    provider.assert_not_called()


def test_workload_federation_preflight_does_not_exchange_credentials(inputs, monkeypatch):
    manifest, source, destination, save, provider = inputs
    manifest["embedding"]["authentication"] = "workload-federation"
    save()
    monkeypatch.delenv("OPENROUTER_API_KEY")
    monkeypatch.setenv("OPENROUTER_FEDERATION_POLICY_ID", "synthetic-policy")
    monkeypatch.setenv("AWS_REGION", "ap-northeast-1")
    token = Mock(side_effect=AssertionError("Must not exchange identity during preflight"))
    monkeypatch.setattr("worker_python.pipeline.ai_connection.openrouter_token", token)
    assert evaluation.prepare(source, destination)["status"] == "ready"
    token.assert_not_called()
    provider.assert_not_called()


@pytest.mark.parametrize("failure", [RuntimeError("private question and Bearer private-token"), None, [[0.0] * 1536], [[float("nan")] * 1536]])
def test_provider_failure_or_invalid_vectors_leave_no_partial_output(inputs, failure):
    _, source, destination, _, provider = inputs
    provider.side_effect = failure if isinstance(failure, Exception) else None
    provider.return_value = failure
    with pytest.raises(evaluation.EvaluationError, match="^embedding_failed$"):
        evaluation.prepare(source, destination, execute=True)
    assert list(source.parent.iterdir()) == [source]


def test_existing_output_and_lock_are_never_overwritten_or_billed(inputs):
    _, source, destination, _, provider = inputs
    destination.write_text("previous verified vectors")
    with pytest.raises(evaluation.EvaluationError, match="output_exists"):
        evaluation.prepare(source, destination, execute=True)
    assert destination.read_text() == "previous verified vectors"
    destination.unlink()
    lock = destination.parent / ("." + destination.name + ".lock")
    lock.write_text("another invocation")
    with pytest.raises(evaluation.EvaluationError, match="output_locked"):
        evaluation.prepare(source, destination, execute=True)
    assert lock.read_text() == "another invocation"
    provider.assert_not_called()


@pytest.mark.parametrize("permission", ["file", "directory", "symlink"])
def test_private_paths_are_required(inputs, permission):
    _, source, destination, _, provider = inputs
    if permission == "file":
        source.chmod(0o644)
    elif permission == "directory":
        source.parent.chmod(0o755)
    else:
        real = source.with_name("real.json")
        source.rename(real)
        source.symlink_to(real)
    with pytest.raises(evaluation.EvaluationError):
        evaluation.prepare(source, destination, execute=True)
    provider.assert_not_called()


def test_batches_queries_without_repeating_performance_samples(inputs):
    manifest, source, destination, save, provider = inputs
    manifest["samples"] = 30
    manifest["cases"] = [{**copy.deepcopy(manifest["cases"][0]), "id": f"q{i}", "question": f"question {i}"} for i in range(17)]
    save()
    evaluation.prepare(source, destination, execute=True)
    assert [len(call.args[0]) for call in provider.call_args_list] == [16, 1]
    assert all(call.kwargs == {"input_type": "query"} for call in provider.call_args_list)


def test_cli_preflight_and_configuration_failure_never_print_private_content(inputs):
    manifest, source, destination, save, _ = inputs
    command = [sys.executable, str(Path(__file__).resolve().parents[1] / "scripts/prepare_search_evaluation.py"), "--input", str(source), "--output", str(destination)]
    result = subprocess.run(command, capture_output=True, text=True)
    assert result.returncode == 0
    assert json.loads(result.stdout)["model_calls_made"] is False
    manifest["embedding"]["model"] = "private-model-mismatch"
    save()
    result = subprocess.run(command + ["--execute"], capture_output=True, text=True)
    assert result.returncode == 1
    assert json.loads(result.stderr) == {"status": "failed", "code": "configuration_mismatch"}
    assert "private-model" not in result.stderr and "比較の質問" not in result.stdout + result.stderr


def test_onprem_768_profile_uses_current_configuration_without_cloud_bindings(inputs, monkeypatch):
    manifest, source, destination, save, provider = inputs
    monkeypatch.delenv("OPENROUTER_API_KEY")
    monkeypatch.setenv("EMBEDDING_PROFILE", "embeddinggemma2")
    monkeypatch.setenv("EMBEDDING_MODEL", "existing-local-embedding-model")
    monkeypatch.setenv("EMBEDDING_BASE_URL", "http://127.0.0.1:8000/v1")
    monkeypatch.setenv("EMBEDDING_API_KEY", "synthetic-local-model-key")
    manifest["embedding"].update(profile="embeddinggemma2", model="existing-local-embedding-model", dimensions=768, baseUrl="http://127.0.0.1:8000/v1")
    save()
    provider.side_effect = lambda texts, **_: [[1.0] + [0.0] * 767 for _ in texts]
    assert evaluation.prepare(source, destination, execute=True)["dimensions"] == 768
    assert len(json.loads(destination.read_text())["cases"][0]["queryEmbedding"]) == 768
    provider.assert_called_once_with(["比較の質問 🌸"], input_type="query")


def test_late_batch_failure_never_publishes_a_partial_query_set(inputs):
    manifest, source, destination, save, provider = inputs
    manifest["cases"] = [{**manifest["cases"][0], "id": f"q{i}", "question": f"question {i}"} for i in range(17)]
    save()
    provider.side_effect = [[[1.0] + [0.0] * 1535 for _ in range(16)], RuntimeError("private provider failure")]
    with pytest.raises(evaluation.EvaluationError, match="embedding_failed"):
        evaluation.prepare(source, destination, execute=True)
    assert provider.call_count == 2
    assert list(source.parent.iterdir()) == [source]


def test_concurrent_publisher_is_not_overwritten(inputs):
    _, source, destination, _, provider = inputs
    def competing_result(texts, **_):
        destination.write_text("concurrent verified result")
        destination.chmod(0o600)
        return [[1.0] + [0.0] * 1535 for _ in texts]
    provider.side_effect = competing_result
    with pytest.raises(evaluation.EvaluationError, match="output_write_failed"):
        evaluation.prepare(source, destination, execute=True)
    assert destination.read_text() == "concurrent verified result"
    assert set(source.parent.iterdir()) == {source, destination}


def test_duplicate_json_keys_and_oversized_inputs_are_rejected(inputs):
    _, source, destination, _, provider = inputs
    for data in ['{"version":1,"version":2}', ' ' * (evaluation.MAX_INPUT_BYTES + 1)]:
        source.write_text(data)
        with pytest.raises(evaluation.EvaluationError):
            evaluation.prepare(source, destination, execute=True)
    provider.assert_not_called()


def test_packaged_module_entry_point_needs_no_repository_script(inputs):
    _, source, destination, _, _ = inputs
    result = subprocess.run([sys.executable, "-m", "worker_python.search_evaluation", "--input", str(source), "--output", str(destination)],
                            cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True)
    assert result.returncode == 0 and json.loads(result.stdout)["model_calls_made"] is False
    assert not destination.exists()


def test_invalid_unicode_is_rejected_before_provider_calls(inputs):
    manifest, source, destination, _, provider = inputs
    manifest["cases"][0]["question"] = "\ud800"
    source.write_text(json.dumps(manifest, ensure_ascii=True))
    with pytest.raises(evaluation.EvaluationError, match="invalid_manifest"):
        evaluation.prepare(source, destination, execute=True)
    provider.assert_not_called()


def test_cli_drops_unknown_error_details_instead_of_logging_them(inputs, monkeypatch, capsys):
    _, source, destination, _, _ = inputs
    monkeypatch.setattr(evaluation, "prepare", Mock(side_effect=RuntimeError("Bearer private-token private-question")))
    assert evaluation.cli(["--input", str(source), "--output", str(destination)]) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert json.loads(captured.err) == {"status": "failed", "code": "evaluation_failed"}
