import hashlib
import json

import pytest

import provision


def settings(tmp_path):
    return {"MODEL_REPO": "example/weights", "MODEL_REVISION": "a" * 40, "MODEL_FILE": "model.gguf",
            "MODEL_SHA256": hashlib.sha256(b"weights").hexdigest(), "MODEL_ROOT": str(tmp_path)}


def test_pinned_gguf_and_cached_offline_restart(tmp_path, monkeypatch):
    env = settings(tmp_path)
    calls = []

    def download(repo, filename, *, revision, local_dir):
        calls.append((repo, filename, revision))
        target = local_dir / filename
        target.write_bytes(b"weights")
        return str(target)

    monkeypatch.setattr(provision, "hf_hub_download", download)
    directory = provision.provision(env)
    assert calls == [(env["MODEL_REPO"], "model.gguf", env["MODEL_REVISION"])]
    monkeypatch.setattr(provision, "hf_hub_download", lambda *a, **kw: pytest.fail("cached restart used the network"))
    assert provision.provision(env) == directory
    assert (directory / ".videoq-model.json").is_file()


@pytest.mark.parametrize("change", [{"MODEL_REVISION": "main"}, {"MODEL_FILE": "../evil.gguf"}, {"MODEL_SHA256": ""}])
def test_rejects_unpinned_or_unsafe_inputs(tmp_path, change):
    with pytest.raises(ValueError):
        provision.provision({**settings(tmp_path), **change})


def test_wrong_checksum_never_marks_model_ready(tmp_path, monkeypatch):
    env = settings(tmp_path)
    directory = tmp_path / env["MODEL_REVISION"]

    def download(*args, **kwargs):
        target = directory / "model.gguf"
        target.write_bytes(b"wrong")
        return str(target)

    monkeypatch.setattr(provision, "hf_hub_download", download)
    with pytest.raises(ValueError, match="checksum"):
        provision.provision(env)
    assert not (directory / ".videoq-model.json").exists()


def test_snapshot_downloads_only_serving_data_and_detects_missing_cached_weights(tmp_path, monkeypatch):
    env = {**settings(tmp_path), "MODEL_FILE": "", "MODEL_SHA256": ""}
    calls = []

    def snapshot(repo, *, revision, local_dir, allow_patterns, ignore_patterns):
        assert "*.py" not in allow_patterns and "*.bin" not in allow_patterns
        assert "original/**" in ignore_patterns
        calls.append(revision)
        (local_dir / "config.json").write_text("{}")
        (local_dir / "model.safetensors").write_bytes(b"weights")

    monkeypatch.setattr(provision, "snapshot_download", snapshot)
    directory = provision.provision(env)
    assert provision.provision(env) == directory
    assert len(calls) == 1
    (directory / "model.safetensors").unlink()
    provision.provision(env)
    assert len(calls) == 2
    assert json.loads((directory / ".videoq-model.json").read_text())["identity"]["revision"] == env["MODEL_REVISION"]


def test_ggml_speech_weights_are_pinned_and_checksum_checked(tmp_path, monkeypatch):
    env = {**settings(tmp_path), "MODEL_FILE": "ggml-small-q5_1.bin"}
    def download(repo, filename, *, revision, local_dir):
        assert filename == "ggml-small-q5_1.bin"
        target = local_dir / filename
        target.write_bytes(b"weights")
        return str(target)
    monkeypatch.setattr(provision, "hf_hub_download", download)
    assert (provision.provision(env) / "ggml-small-q5_1.bin").is_file()
    with pytest.raises(ValueError):
        provision.provision({**env, "MODEL_FILE": "arbitrary-pickle.bin"})
