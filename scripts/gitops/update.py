"""Host-local verified release follower. Git is local; public artifacts are upstream.

An explicit initialize records the already accepted deployment. A timer runs once;
any interrupted/failed mutation blocks later updates until an operator recovers it.
Argo automated/selfHeal must remain OFF: this coordinator owns the backup/sync gate.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.request

from repository import validate_repository
import promote
from lifecycle import Lifecycle, WRITERS, BACKENDS, verify_backup
from common import private_json

IMAGE_IMPORT_DIRECTORY = Path("/var/lib/rancher/k3s/agent/images")


def run(*args, cwd=None, capture=False):
    return subprocess.check_output(args, cwd=cwd, text=True, timeout=10800).strip() if capture else subprocess.run(args, cwd=cwd, check=True, timeout=10800)


def identity(lock):
    return {k: lock[k] for k in ('sourceSha', 'runId', 'runAttempt')}


def newer(candidate, current):
    return (int(candidate['run_id']), candidate['run_attempt']) > (int(current['runId']), current['runAttempt'])


def select_release(current):
    for candidate in promote.public_release.releases():
        if not newer(candidate, current):
            return None
        # An API/network/verification error fails closed, never guesses a version.
        promote.public_release.check_run(candidate)
        return candidate
    return None


def image_refs(objects):
    refs = set()
    for obj in objects:
        pod = obj.get('spec', {}).get('template', {}).get('spec', {})
        if obj['kind'] == 'CronJob':
            pod = obj['spec']['jobTemplate']['spec']['template']['spec']
        for c in pod.get('containers', []) + pod.get('initContainers', []):
            refs.add(c['image'])
    return sorted(refs)


def assert_manual(app):
    policy = app['spec'].get('syncPolicy', {}).get('automated')
    if policy is not None and policy.get('enabled') is not False:
        raise ValueError('Disable Argo automated/self-heal before coordinated updates')
    if app.get('operation'):
        raise ValueError('An Argo operation is already running')


class Host(Lifecycle):
    def __init__(self, config, directory):
        self.config = config
        self.directory = directory
        self.state_path = directory / 'state.json'
        self.kubeconfig = Path(config['kubeconfig'])
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}
        self.repo = Path(config['checkout'])
        self.site = 'clusters/' + config['site']

    def kube(self, *args, capture=False):
        return run('kubectl', '--kubeconfig', str(self.kubeconfig), '-n', 'videoq', *args, capture=capture)

    def apply(self, value):
        subprocess.run(['kubectl', '--kubeconfig', str(self.kubeconfig), '-n', 'videoq', 'apply', '-f', '-'],
                       input=json.dumps(value), text=True, check=True)

    def app(self):
        return json.loads(self.kube('get', 'application', 'lab-videoq', '-n', 'argocd', '-o', 'json', capture=True))

    def identities(self):
        return {n: json.loads(self.kube('get', 'namespace', n, '-o', 'json', capture=True))['metadata']['uid']
                for n in ('kube-system', 'videoq')}

    def check_cluster_identity(self):
        if self.identities() != self.state['clusterUids']:
            raise ValueError('Cluster identity changed; no workloads were modified')

    def healthy(self, revision, smoke=False):
        app = self.app()
        assert_manual(app)
        if (app['spec']['source']['repoURL'] != self.config['repository'] or
                app['spec']['source']['path'] != self.site + '/videoq' or
                app['status']['sync'].get('revision') != revision or
                app['status']['sync']['status'] != 'Synced' or app['status']['health']['status'] != 'Healthy'):
            raise ValueError('Accepted Git revision and healthy runtime do not match')
        d = json.loads(self.kube('get', 'deployments', '-o', 'json', capture=True))['items']
        if len(d) != 10 or any(x['spec'].get('replicas') != 1 or x['status'].get('availableReplicas') != 1 for x in d):
            raise ValueError('All ten deployments must be available before/after an update')
        # Use the installed CA, without disabling certificate verification.
        import ssl
        ctx = ssl.create_default_context(cafile=self.config['ca_file'])
        with urllib.request.urlopen(self.config['public_url'] + '/ready', context=ctx, timeout=30) as response:
            if response.status != 200:
                raise ValueError('VideoQ readiness failed')
        if smoke:
            subprocess.run(self.config['health_command'], check=True, timeout=self.config.get('health_timeout_seconds', 600))

    def checkout(self):
        repository = validate_repository(self.config['repository'])
        branch = self.config['branch']
        if run('git', 'check-ref-format', '--branch', branch, capture=True) != branch:
            raise ValueError('Invalid branch')
        if not self.repo.exists():
            run('git', 'clone', '--branch', branch, '--single-branch', repository, str(self.repo))
        if run('git', 'remote', 'get-url', 'origin', cwd=self.repo, capture=True) != repository:
            raise ValueError('Unexpected configuration repository')
        if run('git', 'status', '--porcelain', cwd=self.repo, capture=True):
            raise ValueError('Configuration checkout has uncommitted edits')
        run('git', 'fetch', 'origin', branch, cwd=self.repo)
        remote = run('git', 'rev-parse', 'FETCH_HEAD', cwd=self.repo, capture=True)
        local = run('git', 'rev-parse', 'HEAD', cwd=self.repo, capture=True)
        if self.state and local != self.state['revision']:
            raise ValueError('Unexpected local Git revision; inspect the journal')
        run('git', 'merge', '--ff-only', remote, cwd=self.repo)
        return remote

    def lock(self):
        return json.loads((self.repo / self.site / 'release-lock.json').read_text())

    def cache_images(self, root, objects):
        # Cache every referenced image before downtime. Archive the four own image
        # families so GitHub retention does not control local restart/recovery.
        refs = image_refs(objects)
        for ref in refs:
            run('k3s', 'ctr', 'images', 'pull', '--platform', 'linux/amd64', ref)
        own = [x for x in refs if x.startswith('ghcr.io/videoq-jp/videoq-')]
        if len(set(x.split('@')[0] for x in own)) != 4:
            raise ValueError('Expected exactly four signed application image families')
        archive = root / 'application-images.tar'
        if not archive.exists():
            staging = root / 'application-images.partial'
            run('k3s', 'ctr', 'images', 'export', '--platform', 'linux/amd64', str(staging), *own)
            os.replace(staging, archive)
        os.chmod(archive, 0o600)
        # Native K3s imports these archives on boot (and watches while running).
        # Only updater-owned files are linked here; no other images are removed.
        imports = IMAGE_IMPORT_DIRECTORY
        imports.mkdir(mode=0o700, parents=True, exist_ok=True)
        destination = imports / ('videoq-' + root.name + '.tar')
        if destination.exists():
            from lifecycle import checksum
            if checksum(archive) != checksum(destination):
                raise ValueError('Image import archive checksum differs')
        else:
            staging = destination.with_suffix('.partial')
            shutil.copyfile(archive, staging)
            os.chmod(staging, 0o600)
            os.replace(staging, destination)

    def initialize(self, revision):
        if self.state:
            raise ValueError('Already initialized; never overwrite the acceptance journal')
        lock = self.lock()
        self.healthy(revision, smoke=True)
        root = self.directory / 'accepted-initial'
        root.mkdir(mode=0o700, exist_ok=True)
        objects = json.loads((self.repo / self.site / 'videoq/resources.json').read_text())['items']
        self.cache_images(root, objects)
        self.state = {**identity(lock), 'revision': revision, 'clusterUids': self.identities(),
                      'acceptedImages': str(root / 'application-images.tar')}
        self.save_state()

    def prepare(self, selected):
        root = self.directory / ('release-' + selected['run_id'] + '-' + str(selected['run_attempt']))
        root.mkdir(mode=0o700, exist_ok=True)
        bundle = root / 'bundle'
        public = promote.public_release
        if not public.verifier_ready():
            raise ValueError('Install pinned signature verification tools first')
        public.download(selected, bundle)
        run(str(public.verifier_python()), str(public.VERIFIER), selected['source_sha'], selected['run_id'],
            str(selected['run_attempt']), str(bundle), str(bundle / 'verified-images.json'), str(bundle / 'verified-inference.json'))
        # Keep the reviewed compiler itself fixed. Fetch only the immutable
        # commit needed by checked_source; never execute new upstream Python as
        # root. Recipe changes fail closed and require a maintenance upgrade.
        if run('git', 'remote', 'get-url', 'origin', cwd=promote.ROOT, capture=True) != 'https://github.com/videoq-jp/videoq.git':
            raise ValueError('Unexpected updater source repository')
        run('git', 'fetch', 'origin', selected['source_sha'], cwd=promote.ROOT)
        output = root / 'generated'
        run(sys.executable, str(promote.ROOT / 'scripts/gitops/promote.py'), '--release-directory', str(bundle),
            '--source-sha', selected['source_sha'], '--run-id', selected['run_id'], '--run-attempt', str(selected['run_attempt']),
            '--repository', self.config['repository'], '--revision', self.config['branch'], '--site', self.config['site'],
            '--public-url', self.config['public_url'], '--listen-ip', self.config['listen_ip'], '--storage-gib', str(self.config['storage_gib']),
            '--output', str(output), '--deployment-pin-output', str(root / 'local-image-pins.json'))
        generated = output / self.site
        # Infrastructure/GPU topology changes need explicit acceptance rather than
        # changing the shared GPU driver/plugin during an application update.
        oldlock = self.lock()
        newlock = json.loads((generated / 'release-lock.json').read_text())
        if oldlock['bootstrapPins'] != newlock['bootstrapPins']:
            raise ValueError('Bootstrap pin change requires an explicit maintenance upgrade')
        if (self.repo / self.site / 'gpu/resources.json').read_bytes() != (generated / 'gpu/resources.json').read_bytes():
            raise ValueError('GPU configuration change requires explicit maintenance')
        objects = json.loads((generated / 'videoq/resources.json').read_text())['items']
        self.cache_images(root, objects)
        return root, generated, newlock

    def stop_operation(self):
        # Scaling while Argo still reconciles can reopen writers after failure.
        app = self.app()
        operation = app.get('operation')
        if not operation:
            return
        owner = self.state['pending_update']['id']
        if {'name': 'videoq-update-id', 'value': owner} not in operation.get('info', []):
            raise ValueError('Another administrator owns the Argo operation; no termination attempted')
        self.kube('patch', 'application', 'lab-videoq', '-n', 'argocd', '--type=json', '-p',
                  json.dumps([{'op': 'test', 'path': '/metadata/resourceVersion', 'value': app['metadata']['resourceVersion']},
                              {'op': 'replace', 'path': '/status/operationState/phase', 'value': 'Terminating'}]))
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            if not self.app().get('operation'):
                return
            time.sleep(3)
        raise ValueError('Argo operation did not terminate; operator intervention required')

    def update_once(self, revision):
        if not self.state:
            raise ValueError('Initialize only after initial deployment acceptance')
        if self.state.get('pending_update'):
            raise ValueError('Interrupted/failed update requires operator recovery; timer will not retry writes')
        self.check_cluster_identity()
        if revision != self.state['revision']:
            raise ValueError('Configuration branch advanced outside updater; explicit acceptance required')
        self.healthy(revision)
        if identity(self.lock()) != {k: self.state[k] for k in ('sourceSha', 'runId', 'runAttempt')}:
            raise ValueError('Git release changed outside the updater; accept it explicitly')
        selected = select_release(self.state)
        if not selected:
            print('Already following the latest successful formal release')
            return
        root, generated, target = self.prepare(selected)
        # Prepare/download failure above has no runtime effects.
        runtime = self.runtime_snapshot()
        pending = {'id': secrets.token_hex(16), 'phase': 'selected', 'backup': str(root / 'snapshot'),
                   'runtime': runtime, 'target': selected, 'previousRevision': revision}
        self.state['pending_update'] = pending
        # Lifecycle backup uses snake_case release identities.
        self.state.update(source_sha=self.state['sourceSha'], run_id=self.state['runId'], run_attempt=self.state['runAttempt'])
        private_json(self.directory / 'site-public.json', {'public_url': self.config['public_url']})
        self.save_state()
        try:
            self.quiesce(runtime)
            self.cold_backup(pending)
            # Restore infrastructure, but keep traffic/application writers stopped.
            self.scale(BACKENDS, None, runtime)
            run('git', 'fetch', 'origin', self.config['branch'], cwd=self.repo)
            if run('git', 'rev-parse', 'FETCH_HEAD', cwd=self.repo, capture=True) != revision:
                raise ValueError('Another administrator changed Git; no release will be applied')
            for path in ('videoq/resources.json', 'release-lock.json'):
                (self.repo / self.site / path).write_bytes((generated / path).read_bytes())
            run('git', '-c', 'user.name=VideoQ updater', '-c', 'user.email=videoq-updater@localhost',
                'commit', '-am', 'Update VideoQ to ' + selected['tag'], cwd=self.repo)
            commit = run('git', 'rev-parse', 'HEAD', cwd=self.repo, capture=True)
            pending.update(phase='publishing', targetRevision=commit)
            self.save_state()
            # No force push; concurrent changes reject the push before sync.
            run('git', 'push', 'origin', 'HEAD:refs/heads/' + self.config['branch'], cwd=self.repo)
            pending['phase'] = 'syncing'
            self.save_state()
            app = self.app()
            assert_manual(app)
            # Do not overwrite an operation inserted by another administrator.
            self.kube('patch', 'application', 'lab-videoq', '-n', 'argocd', '--type=json', '-p',
                      json.dumps([{'op': 'test', 'path': '/metadata/resourceVersion', 'value': app['metadata']['resourceVersion']},
                                  {'op': 'add', 'path': '/operation', 'value': {'initiatedBy': {'username': 'videoq-updater'},
                                      'info': [{'name': 'videoq-update-id', 'value': pending['id']}],
                                      'sync': {'revision': commit, 'prune': False}}}]))
            deadline = time.monotonic() + self.config.get('sync_timeout_seconds', 10800)
            while time.monotonic() < deadline:
                app = self.app()
                op = app.get('status', {}).get('operationState', {})
                if op.get('syncResult', {}).get('revision') == commit:
                    if op.get('phase') in ('Failed', 'Error'):
                        raise ValueError('Argo release sync failed')
                    if (op.get('phase') == 'Succeeded' and app['status']['health']['status'] == 'Healthy'
                            and app['status']['sync']['status'] == 'Synced'
                            and app['status']['sync']['revision'] == commit and not app.get('operation')):
                        break
                time.sleep(5)
            else:
                raise ValueError('Argo release sync timed out; inspect it before recovering')
            self.healthy(commit, smoke=True)
            self.restore_cronjobs(runtime)
            self.state.update(identity(target), source_sha=target['sourceSha'], run_id=target['runId'],
                              run_attempt=target['runAttempt'], revision=commit, previousImages=self.state['acceptedImages'],
                              acceptedImages=str(root / 'application-images.tar'), lastBackup=pending['backup'])
            self.state.pop('pending_update')
            self.save_state()
            print('Updated and verified ' + selected['tag'])
        except BaseException:
            # Never deploy old code against a possibly migrated DB. Retain both
            # image archives, Git history, snapshot and pending journal.
            if pending['phase'] in ('selected', 'backed_up'):
                self.scale(BACKENDS, None, runtime)
                self.scale(WRITERS, None, runtime)
                self.restore_cronjobs(runtime)
            else:
                self.stop_operation()
                self.quiesce(runtime, backends=False)
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--initialize', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    config = json.loads(args.config.read_text())
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,30}', config['site']):
        raise ValueError('Invalid site')
    if not config.get('health_command') or not Path(config['health_command'][0]).is_absolute():
        raise ValueError('Configure an absolute operator-owned smoke-test executable')
    directory = Path(config['state_directory'])
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (directory / 'operation.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        host = Host(config, directory)
        revision = host.checkout()
        host.initialize(revision) if args.initialize else host.update_once(revision)


if __name__ == '__main__':
    main()
