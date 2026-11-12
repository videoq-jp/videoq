"""Reference-aware GHCR/release retention. Plan first; apply only the saved plan.

Keep two published on-prem generations, all other release types, recent builds,
operational source references, index children and signature/referrer graphs.
No image builds or deployment changes. Authentication stays inside gh.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

REPO = 'videoq-jp/videoq'
ORG = 'videoq-jp'
PACKAGES = tuple('videoq-' + c for c in ('api', 'web', 'worker', 'transcription-gateway', 'vllm'))
DIGEST = re.compile(r'sha256:[a-f0-9]{64}')
TAG = re.compile(r'onprem-([a-f0-9]{40})-([1-9][0-9]*)-([1-9][0-9]*)')
ACCEPT = ', '.join(('application/vnd.oci.image.index.v1+json', 'application/vnd.oci.image.manifest.v1+json',
                    'application/vnd.docker.distribution.manifest.list.v2+json', 'application/vnd.docker.distribution.manifest.v2+json'))


def gh(endpoint, *, pages=False, method='GET'):
    command = ['gh', 'api', '-X', method]
    if pages:
        command += ['--paginate', '--slurp']
    result = subprocess.run(command + [endpoint], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f'GitHub {method} failed for {endpoint}; no credentials/body logged')
    return json.loads(result.stdout) if result.stdout.strip() else None


def listing(endpoint):
    return [item for page in gh(endpoint, pages=True) for item in page]


def stamp(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def snapshot():
    releases = listing(f'repos/{REPO}/releases?per_page=100')
    for release in releases:
        match = TAG.fullmatch(release['tag_name'])
        if match and not release['draft'] and not release['prerelease']:
            source, run_id, attempt = match.groups()
            run = gh(f'repos/{REPO}/actions/runs/{run_id}')
            release['verifiedMainRun'] = (release.get('target_commitish') == source and
                run.get('conclusion') == 'success' and run.get('head_branch') == 'main' and
                run.get('head_sha') == source and run.get('run_attempt') == int(attempt) and
                run.get('path') == '.github/workflows/onprem-release.yml' and
                run.get('repository', {}).get('full_name') == REPO)
    inventory = {}
    for package in PACKAGES:
        endpoint = f'orgs/{ORG}/packages/container/{package}'
        meta = gh(endpoint)
        if meta.get('repository', {}).get('full_name') != REPO or meta.get('visibility') != 'public':
            raise ValueError('Unreviewed package identity: ' + package)
        inventory[package] = listing(endpoint + '/versions?per_page=100')
    return {'repository': REPO, 'capturedAt': datetime.now(timezone.utc).isoformat(), 'releases': releases, 'packages': inventory}


def release_roots(releases, keep, fetch_json):
    eligible = sorted((r for r in releases if not r['draft'] and not r['prerelease'] and TAG.fullmatch(r['tag_name']) and r.get('verifiedMainRun') is True),
                      key=lambda r: (r['published_at'], r['id']), reverse=True)
    if len(eligible) < keep:
        raise ValueError('Fewer than the requested protected published generations; refuse cleanup')
    retained_ids = {r['id'] for r in eligible[:keep]}
    retained = [r for r in releases if r['id'] in retained_ids or r not in eligible]
    deleted = [r for r in eligible if r['id'] not in retained_ids]
    roots = {name: set() for name in PACKAGES}
    for release in retained:
        asset = next((a for a in release.get('assets', []) if a['name'] == 'release.json'), None)
        if asset is None:
            if release in eligible:
                raise ValueError('Protected on-prem release lacks a manifest')
            continue
        data = fetch_json(asset['browser_download_url'])
        if data.get('repository') != REPO or not data.get('images'):
            raise ValueError('Protected release manifest identity mismatch')
        for image in data['images'].values():
            repository, digest = image.get('repository', ''), image.get('digest', '')
            package = repository.removeprefix(f'ghcr.io/{ORG}/')
            if repository != f'ghcr.io/{ORG}/{package}' or package not in roots or not DIGEST.fullmatch(digest):
                raise ValueError('Unreviewed protected image identity')
            roots[package].add(digest)
    return roots, retained, deleted


class Registry:
    def __init__(self, cache=None):
        self.directory = cache
        self.tokens = {}
        self.cache = {}
        for package in PACKAGES:
            url = 'https://ghcr.io/token?' + urllib.parse.urlencode({'service': 'ghcr.io', 'scope': f'repository:{ORG}/{package}:pull'})
            self.tokens[package] = fetch_json(url)['token']

    def manifest(self, package, digest):
        key = (package, digest)
        if key in self.cache:
            return self.cache[key]
        cached = self.directory / package / (digest[7:] + '.json') if self.directory else None
        if cached and cached.exists():
            raw = cached.read_bytes()
            if 'sha256:' + hashlib.sha256(raw).hexdigest() != digest:
                raise ValueError('Cached manifest checksum mismatch')
            self.cache[key] = json.loads(raw)
            return self.cache[key]
        request = urllib.request.Request(f'https://ghcr.io/v2/{ORG}/{package}/manifests/{digest}',
                   headers={'Authorization': 'Bearer ' + self.tokens[package], 'Accept': ACCEPT})
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read(16 * 1024 * 1024)
        if 'sha256:' + hashlib.sha256(raw).hexdigest() != digest:
            raise ValueError('Registry manifest checksum mismatch')
        value = json.loads(raw)
        if cached:
            cached.parent.mkdir(parents=True, exist_ok=True)
            temporary = cached.with_suffix('.tmp')
            temporary.write_bytes(raw)
            temporary.replace(cached)
        self.cache[key] = value
        return value


def fetch_json(url):
    if not url.startswith(('https://github.com/', 'https://ghcr.io/')):
        raise ValueError('Unexpected metadata URL')
    with urllib.request.urlopen(urllib.request.Request(url, headers={'Accept': 'application/json'}), timeout=60) as response:
        return json.load(response)


def source_roots(refs):
    roots = {p: set() for p in PACKAGES}
    pattern = re.compile(r'ghcr\.io/videoq-jp/(videoq-[a-z-]+)@(sha256:[a-f0-9]{64})')
    for ref in refs:
        if not re.fullmatch(r'[A-Za-z0-9_./-]+', ref):
            raise ValueError('Invalid source ref')
        result = subprocess.run(['git', 'grep', '-I', '-h', '-E', 'ghcr.io/videoq-jp/videoq-', ref, '--',
                    ':(glob)**/Dockerfile*', ':(glob)charts/**/*.yaml', ':(glob).github/workflows/*.yml',
                    ':(glob)apps/inference/**/runtime-base.json'], capture_output=True, text=True)
        if result.returncode not in (0, 1):
            raise ValueError('Cannot inspect protected source ' + ref)
        for package, digest in pattern.findall(result.stdout):
            if package not in roots:
                raise ValueError('Unknown source package')
            roots[package].add(digest)
        files = subprocess.run(['git', 'ls-tree', '-r', '--name-only', ref, '--', '.github/deployment-pins/'],
                               capture_output=True, text=True, check=True)
        for path in files.stdout.splitlines():
            if not path.endswith('.json'):
                continue
            if not re.fullmatch(r'\.github/deployment-pins/[a-z0-9-]+\.json', path):
                raise ValueError('Unreviewed deployment pin path')
            raw = subprocess.run(['git', 'show', ref + ':' + path], capture_output=True, text=True, check=True)
            for package, digests in deployment_roots(json.loads(raw.stdout)).items():
                roots[package].update(digests)
    return roots


def deployment_roots(data):
    """Only public image identities; never read a lab's private Git credentials."""
    generations = data.get('generations')
    if data.get('schemaVersion') != 1 or not isinstance(generations, list) or not 1 <= len(generations) <= 2:
        raise ValueError('Invalid deployed-generation pin file')
    roots = {p: set() for p in PACKAGES}
    components = {'api', 'worker', 'web', 'transcription-gateway'}
    for generation in generations:
        if (not re.fullmatch(r'[a-f0-9]{40}', generation.get('sourceSha', '')) or
                not re.fullmatch(r'[1-9][0-9]*', str(generation.get('runId', ''))) or
                not isinstance(generation.get('runAttempt'), int) or generation['runAttempt'] < 1 or
                set(generation.get('images', {})) != components):
            raise ValueError('Invalid deployed release identity')
        for component, image in generation['images'].items():
            package = 'videoq-' + component
            digest = image.get('digest', '')
            if image.get('repository') != f'ghcr.io/{ORG}/{package}' or not DIGEST.fullmatch(digest):
                raise ValueError('Unreviewed deployed image identity')
            roots[package].add(digest)
    return roots


def plan(data, roots, retained, removed, fetch_manifest, now, grace_days=7):
    if data['repository'] != REPO or set(data['packages']) != set(PACKAGES):
        raise ValueError('Unexpected inventory scope')
    cutoff = now - timedelta(days=grace_days)
    protected = {p: set(roots[p]) for p in PACKAGES}
    by_digest = {}
    for package, versions in data['packages'].items():
        index = {}
        for v in versions:
            if not isinstance(v['id'], int) or not DIGEST.fullmatch(v['name']) or v['name'] in index:
                raise ValueError('Invalid or duplicate package version')
            index[v['name']] = v
            if stamp(v['created_at']) >= cutoff:
                protected[package].add(v['name'])
        by_digest[package] = index
    # Inspect candidates too: untagged OCI 1.1 referrers may have no fallback tag.
    all_versions = [(p, v['name']) for p, versions in data['packages'].items() for v in versions]
    with ThreadPoolExecutor(max_workers=8) as executor:
        manifest_data = dict(zip(all_versions, executor.map(lambda item: fetch_manifest(*item), all_versions)))
    visited = set()
    # Resolve child manifests AND reverse signature fallback tags until closure.
    while True:
        for (package, digest), manifest in manifest_data.items():
            subject = manifest.get('subject', {}).get('digest')
            if subject in protected[package]:
                protected[package].add(digest)
        for package, versions in data['packages'].items():
            for version in versions:
                for tag in version['metadata']['container']['tags']:
                    match = re.fullmatch(r'sha256-([a-f0-9]{64})(?:\.(?:sig|att|sbom))?', tag)
                    if match and 'sha256:' + match[1] in protected[package]:
                        protected[package].add(version['name'])
        pending = [(p, d) for p in PACKAGES for d in protected[p] if (p, d) not in visited]
        if not pending:
            break
        with ThreadPoolExecutor(max_workers=8) as executor:
            manifests = list(executor.map(lambda item: manifest_data[item] if item in manifest_data else fetch_manifest(*item), pending))
        for (package, digest), manifest in zip(pending, manifests):
            visited.add((package, digest))
            descriptors = list(manifest.get('manifests', []))
            if manifest.get('subject'):
                descriptors.append(manifest['subject'])
            for descriptor in descriptors:
                child = descriptor.get('digest', '')
                if not DIGEST.fullmatch(child):
                    raise ValueError('Invalid manifest child')
                protected[package].add(child)
    deletions = []
    for package, versions in data['packages'].items():
        for version in versions:
            if version['name'] not in protected[package]:
                deletions.append({'package': package, 'id': version['id'], 'digest': version['name'],
                                  'tags': version['metadata']['container']['tags'], 'createdAt': version['created_at']})
    return {'schemaVersion': 1, 'repository': REPO, 'generatedAt': now.isoformat(), 'graceDays': grace_days,
            'keepReleases': [{'id': r['id'], 'tag': r['tag_name']} for r in retained],
            'deleteReleases': [{'id': r['id'], 'tag': r['tag_name']} for r in removed],
            'protectedDigests': {p: sorted(ds) for p, ds in protected.items()}, 'deleteVersions': deletions,
            'inventorySha256': checksum(data), 'manifestGraphsVerified': len(visited)}


def checksum(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def apply(saved, live, fresh, record=None):
    if saved['repository'] != REPO or saved['schemaVersion'] != 1:
        raise ValueError('Unexpected cleanup plan')
    if datetime.now(timezone.utc) - stamp(saved['generatedAt']) > timedelta(hours=24):
        raise ValueError('Plan expired; regenerate and review')
    # The entire live plan must match before the first destructive request.
    for key in ['keepReleases', 'deleteReleases', 'protectedDigests', 'deleteVersions']:
        if saved[key] != fresh[key]:
            raise ValueError('References/inventory changed; regenerate cleanup plan')
    journal = {'status': 'running', 'deletedReleases': [], 'deletedVersions': [], 'planSha256': checksum(saved)}
    if record:
        record(journal)
    for release in saved['deleteReleases']:
        gh(f'repos/{REPO}/releases/{release["id"]}', method='DELETE')
        journal['deletedReleases'].append(release)
        if record:
            record(journal)
    deleted = []
    for version in saved['deleteVersions']:
        try:
            gh(f'orgs/{ORG}/packages/container/{version["package"]}/versions/{version["id"]}', method='DELETE')
        except Exception:
            journal.update(status='failed', failedVersion=version)
            if record:
                record(journal)
            raise
        deleted.append(version)
        journal['deletedVersions'].append(version)
        if record:
            record(journal)
            time.sleep(0.8)
    journal['status'] = 'complete'
    if record:
        record(journal)
    return {'deletedReleases': len(saved['deleteReleases']), 'deletedVersions': len(deleted)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['plan', 'apply'])
    parser.add_argument('--file', required=True, type=Path)
    parser.add_argument('--keep', type=int, default=2)
    parser.add_argument('--grace-days', type=int, default=7)
    parser.add_argument('--source-ref', action='append', default=['origin/main'])
    args = parser.parse_args()
    if args.keep < 2 or args.grace_days < 7:
        parser.error('Keep at least two releases and seven days of build grace')
    # Protect operational image pins in every open same-repository PR as well.
    refs = set(args.source_ref)
    for pull in listing(f'repos/{REPO}/pulls?state=open&per_page=100'):
        head = pull['head']
        if head.get('repo', {}).get('full_name') != REPO:
            continue
        branch = head['ref']
        if not re.fullmatch(r'[A-Za-z0-9_./-]+', branch):
            raise ValueError('Unreviewed open-PR branch name')
        subprocess.run(['git', 'fetch', '--quiet', 'origin',
                        f'refs/heads/{branch}:refs/remotes/origin/{branch}'], check=True)
        refs.add('origin/' + branch)
    args.source_ref = sorted(refs)
    data = snapshot()
    roots, retained, removed = release_roots(data['releases'], args.keep, fetch_json)
    for package, refs in source_roots(args.source_ref).items():
        roots[package].update(refs)
    registry = Registry(args.file.parent / "videoq-retention-manifests")
    result = plan(data, roots, retained, removed, registry.manifest, datetime.now(timezone.utc), args.grace_days)
    result['sourceRefs'] = args.source_ref
    if args.command == 'plan':
        args.file.write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps({'keptReleases': len(retained), 'deleteReleases': len(removed), 'deleteVersions': len(result['deleteVersions']),
                          'manifestGraphsVerified': result['manifestGraphsVerified'], 'plan': str(args.file)}))
    else:
        saved = json.loads(args.file.read_text())
        journal_path = args.file.with_suffix('.result.json')
        def record(value):
            temporary = journal_path.with_suffix('.tmp')
            temporary.write_text(json.dumps(value, indent=2) + '\n')
            temporary.replace(journal_path)
            count = len(value['deletedVersions'])
            if count % 25 == 0 or value['status'] != 'running':
                print(json.dumps({'status': value['status'], 'deletedVersions': count, 'journal': str(journal_path)}), flush=True)
        print(json.dumps(apply(saved, data, result, record)))


if __name__ == '__main__':
    main()
