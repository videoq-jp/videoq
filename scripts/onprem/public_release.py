"""Anonymous public release discovery/download; credential-free verification process."""
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
REPOSITORY = 'videoq-jp/videoq'
TAG = re.compile(r'onprem-([a-f0-9]{40})-([1-9][0-9]*)-([1-9][0-9]*)')
VERIFIER = ROOT / '.github/scripts/onprem_public.py'
SPEC = importlib.util.spec_from_file_location('public_verifier', VERIFIER)
public_verifier = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(public_verifier)


def read_url(url, limit=4 * 1024 * 1024):
    # No Authorization header, GH_TOKEN, GitHub CLI, or credential helper.
    request = Request(url, headers={'User-Agent': 'VideoQ-public-installer', 'Accept': 'application/vnd.github+json' if url.startswith('https://api.github.com/') else 'application/octet-stream'})
    try:
        with urlopen(request, timeout=60) as response:
            data = response.read(limit + 1)
    except HTTPError as error:
        if error.code in (403, 429):
            raise ValueError('GitHub公開APIの利用制限です。時間をおいて再実行してください。ログインは不要です') from None
        raise ValueError('公開配布物を取得できませんでした（HTTP ' + str(error.code) + '）') from None
    except URLError:
        raise ValueError('公開配布物への接続を確認して、再実行してください') from None
    if len(data) > limit:
        raise ValueError('公開配布物が許容サイズを超えています')
    return data


def releases():
    rows = json.loads(read_url(f'https://api.github.com/repos/{REPOSITORY}/releases?per_page=30'))
    candidates = []
    for row in rows:
        match = TAG.fullmatch(row.get('tag_name', ''))
        if not match or row.get('draft') or row.get('prerelease'):
            continue
        source, run, attempt = match.groups()
        if row.get('target_commitish') != source:
            continue
        candidates.append({'run_id': run, 'source_sha': source, 'run_attempt': int(attempt), 'tag': match[0]})
    return sorted(candidates, key=lambda row: (int(row['run_id']), row['run_attempt']), reverse=True)


def catalog_for(run_id=None, source=None, attempt=None):
    # A resumed installation can outlive the latest-page catalog. Resolve its
    # exact immutable tag directly rather than silently selecting a newer run.
    if run_id and source and attempt is not None:
        tag = f'onprem-{source}-{run_id}-{attempt}'
        if not TAG.fullmatch(tag):
            raise ValueError('公開リリースのSHA/run-id/attemptが不正です')
        row = json.loads(read_url(f'https://api.github.com/repos/{REPOSITORY}/releases/tags/{tag}'))
        if row.get('tag_name') != tag or row.get('target_commitish') != source or row.get('draft') or row.get('prerelease'):
            raise ValueError('保存済みの公開リリースが見つかりません')
        return [{'run_id': str(run_id), 'source_sha': source, 'run_attempt': int(attempt), 'tag': tag}]
    return releases()


def select(candidates, run_id=None, source=None, attempt=None):
    selected = next((row for row in candidates if (not run_id or row['run_id'] == str(run_id)) and (not source or row['source_sha'] == source)), None)
    if not selected:
        raise ValueError('指定した版の公開リリースがありません。公開済みのrun-id/source-shaを指定してください')
    if attempt is not None and selected['run_attempt'] != attempt:
        raise ValueError('記録した公開リリースの実行回を変更できません')
    return selected


def check_run(selected):
    run_id, source, attempt = selected['run_id'], selected['source_sha'], selected['run_attempt']
    data = json.loads(read_url(f'https://api.github.com/repos/{REPOSITORY}/actions/runs/{run_id}/attempts/{attempt}'))
    if (data.get('conclusion') != 'success' or data.get('head_branch') != 'main' or data.get('head_sha') != source
            or data.get('run_attempt') != attempt or data.get('repository', {}).get('full_name') != REPOSITORY
            or data.get('path') != '.github/workflows/onprem-release.yml'):
        raise ValueError('mainの成功したOn-prem Release実行と公開配布物が一致しません')


def download(selected, destination):
    destination = Path(destination)
    base = f'https://github.com/{REPOSITORY}/releases/download/{quote(selected["tag"], safe="")}/'
    raw = read_url(base + 'release.json')
    data = public_verifier.manifest.validate(json.loads(raw), selected['source_sha'])
    files = public_verifier.required_files(data)
    if all((destination / name).is_file() and (destination / name).stat().st_size for name in files):
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=destination.parent) as staging:
        staging = Path(staging)
        (staging / 'release.json').write_bytes(raw)
        for name in files:
            if name != 'release.json':
                (staging / name).write_bytes(read_url(base + quote(name, safe=''), limit=64 * 1024 * 1024))
        destination.mkdir(mode=0o700, exist_ok=True)
        for name in files:
            os.replace(staging / name, destination / name)


def verifier_python():
    return Path(os.environ.get('VIDEOQ_VERIFY_PYTHON', str(Path.home() / '.local/share/videoq-verifier/bin/python')))


def verifier_ready():
    python = verifier_python()
    return python.is_file() and subprocess.run([str(python), '-c', 'import importlib.metadata; assert importlib.metadata.version("sigstore") == "4.5.1"'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def main():
    import argparse
    parser = argparse.ArgumentParser(description='Download and verify signed public VideoQ artifacts without GitHub login')
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--run-id')
    parser.add_argument('--source-sha')
    parser.add_argument('--run-attempt', type=int)
    args = parser.parse_args()
    try:
        if not verifier_ready():
            raise ValueError('先に bash scripts/onprem/install-verify-tools.sh を実行してください')
        candidates = catalog_for(args.run_id, args.source_sha, args.run_attempt)
        selected = select(candidates, args.run_id, args.source_sha, args.run_attempt)
        check_run(selected)
        download(selected, args.directory)
        subprocess.run([str(verifier_python()), str(VERIFIER), selected['source_sha'], selected['run_id'], str(selected['run_attempt']), str(args.directory), str(args.directory / 'verified-images.json'), str(args.directory / 'verified-inference.json')], check=True)
        return 0
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print('公開配布物の検証を停止しました: ' + str(error))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
