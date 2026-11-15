import hashlib
import os
from pathlib import Path
import subprocess

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "security/fetch-verified.sh"


@pytest.fixture
def downloader(tmp_path):
    tools = tmp_path / "tools"
    tools.mkdir()
    curl = tools / "curl"
    curl.write_text('''#!/bin/sh
set -eu
n=0
[ ! -f "$FETCH_STATE" ] || n=$(cat "$FETCH_STATE")
n=$((n+1))
printf '%s' "$n" > "$FETCH_STATE"
while [ "$1" != '-o' ]; do shift; done
shift
case "$FETCH_MODE:$n" in
  network:1) printf partial > "$1"; exit 22 ;;
  bad:1|always_bad:*) printf unverified > "$1" ;;
  *) printf verified > "$1" ;;
esac
''')
    curl.chmod(0o700)
    state = tmp_path / "attempts"
    target = tmp_path / "archive.tar.gz"
    env = dict(os.environ, PATH=str(tools) + os.pathsep + os.environ["PATH"], FETCH_STATE=str(state))
    def run(mode, digest=hashlib.sha256(b"verified").hexdigest(), url="https://example.invalid/archive.tar.gz"):
        return subprocess.run(["sh", str(SCRIPT), url, digest, str(target)], env=dict(env, FETCH_MODE=mode), capture_output=True, text=True)
    return run, state, target


@pytest.mark.parametrize("mode", ["bad", "network"])
def test_only_a_verified_retry_is_published(downloader, mode):
    run, state, target = downloader
    assert run(mode).returncode == 0
    assert state.read_text() == "2"
    assert target.read_bytes() == b"verified"
    assert list(target.parent.glob("*.download.*")) == []


def test_persistent_mismatch_fails_after_three_attempts_without_overwriting(downloader):
    run, state, target = downloader
    target.write_bytes(b"previous artifact")
    result = run("always_bad")
    assert result.returncode != 0
    assert state.read_text() == "3"
    assert target.read_bytes() == b"previous artifact"
    assert list(target.parent.glob("*.download.*")) == []


@pytest.mark.parametrize("digest,url", [("x" * 64, "https://example.invalid/source"), ("a" * 63, "https://example.invalid/source"), ("a" * 64, "http://example.invalid/source")])
def test_invalid_pin_or_insecure_source_is_refused_before_download(downloader, digest, url):
    run, state, target = downloader
    assert run("bad", digest, url).returncode != 0
    assert not state.exists()
    assert not target.exists()


def test_first_valid_response_does_not_retry(downloader):
    run, state, target = downloader
    assert run("valid").returncode == 0
    assert state.read_text() == "1"
    assert target.read_bytes() == b"verified"
