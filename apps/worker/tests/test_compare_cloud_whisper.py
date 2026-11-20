"""Verify pilot preflight and the full public-fixture comparison without network access."""
import importlib.util
import json
from pathlib import Path
import sys

SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))
spec = importlib.util.spec_from_file_location("compare_cloud_whisper", SCRIPT_DIR / "compare_cloud_whisper.py")
comparison = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comparison)


def test_missing_credentials_report_names_without_calling_providers(monkeypatch, tmp_path):
    for name in ("CLOUDFLARE_ACCOUNT_ID", "WORKERS_AI_API_TOKEN", "OPENROUTER_API_KEY", "OPENROUTER_FEDERATION_POLICY_ID"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(comparison, "_whisper_transcribe", lambda *a, **kw: (_ for _ in ()).throw(AssertionError("unexpected API call")))
    output = tmp_path / "report.json"
    monkeypatch.setattr(sys, "argv", ["compare", "--output", str(output)])
    assert comparison.main() == 1
    report = json.loads(output.read_text())
    assert len(report["cases"]) == 2
    assert all(row["error"] == "MissingConfiguration" for row in report["cases"])
    assert report["cases"][1]["missing"] == ["CLOUDFLARE_ACCOUNT_ID", "WORKERS_AI_API_TOKEN"]


def test_public_fixtures_assessment_and_provider_error_redaction(monkeypatch, tmp_path):
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "a" * 32)
    monkeypatch.setenv("WORKERS_AI_API_TOKEN", "private-test-token")
    fixtures = Path(__file__).resolve().parents[2] / "inference/whisper/tests/fixtures"
    def transcribe(audio, language):
        if language == "en":
            raise RuntimeError("private-test-token should never enter report")
        case = json.loads((fixtures / "fleurs-ja-00.json").read_text())
        return [{"start": 0, "end": case["duration"], "text": case["reference"]}]
    monkeypatch.setattr(comparison, "_whisper_transcribe", transcribe)
    output = tmp_path / "report.json"
    monkeypatch.setattr(sys, "argv", ["compare", "--backends", "workers-ai", "--output", str(output)])
    assert comparison.main() == 1
    report = json.loads(output.read_text())
    assert report["cases"][0]["assessment"]["cer"] == 0
    assert report["cases"][0]["estimated_inference_usd"] > 0
    assert report["cases"][1]["error"] == "RuntimeError"
    assert "private-test-token" not in output.read_text()
