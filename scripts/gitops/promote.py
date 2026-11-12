"""Compile verified release charts into a reviewable, secret-free GitOps change.

No deployment or Git push occurs here. Run from the reviewed release checkout;
the output belongs in the separate lab configuration repository.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.request

import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/onprem'))
import public_release
from native import application_values, backing_plan


def read_documents(raw):
    return [item for item in yaml.safe_load_all(raw) if item]


def checked_source(source):
    if not re.fullmatch(r'[a-f0-9]{40}', source):
        raise ValueError('Invalid source SHA')
    # Templates and bootstrap scripts must be from the release being promoted.
    paths = ['scripts/onprem/' + name for name in ('native.py', 'k3s.py', 'common.py', 'endpoint.py')]
    paths += ['charts/videoq/examples/single-node/' + name for name in
              ('infrastructure.yaml', 'garage.toml', 'elasticmq.conf')]
    paths += ['infra/garage/init.py', 'charts/videoq/examples/local-ai-gpt-oss.yaml',
              'charts/videoq-inference/examples/rtx4090-gpt-oss-embeddinggemma.yaml']
    for path in paths:
        signed = subprocess.check_output(['git', '-C', str(ROOT), 'show', source + ':' + path])
        if signed != (ROOT / path).read_bytes():
            raise ValueError('Release recipe differs from this checkout: ' + path)


def render(chart, name, values, overlays=()):
    with tempfile.TemporaryDirectory() as temporary:
        path = Path(temporary) / 'values.json'
        path.write_text(json.dumps(values))
        command = [os.environ.get('HELM_BIN', 'helm'), 'template', name, str(chart),
                   '--namespace', 'videoq', '--kube-version', '1.37.2', '--skip-tests']
        for overlay in overlays:
            command += ['-f', str(overlay)]
        command += ['-f', str(path)]
        return read_documents(subprocess.check_output(command, text=True))


def deep_merge(left, right):
    result = copy.deepcopy(left)
    for key, value in right.items():
        result[key] = deep_merge(result.get(key, {}), value) if isinstance(value, dict) else value
    return result


def order(item, wave):
    item = copy.deepcopy(item)
    metadata = item.setdefault('metadata', {})
    metadata['namespace'] = 'videoq'
    annotations = metadata.setdefault('annotations', {})
    annotations['argocd.argoproj.io/sync-wave'] = str(wave)
    if item['kind'] == 'PersistentVolumeClaim':
        annotations['argocd.argoproj.io/sync-options'] = 'Prune=false,Delete=false'
    # Helm's pre-install hook would otherwise execute BEFORE the DB exists.
    if annotations.get('helm.sh/hook'):
        if item['kind'] != 'Job' or metadata['name'] != 'videoq-migrate':
            raise ValueError('An unreviewed Helm hook requires an explicit GitOps mapping')
        for key in list(annotations):
            if key.startswith('helm.sh/hook'):
                del annotations[key]
        annotations.update({'argocd.argoproj.io/hook': 'Sync',
                            'argocd.argoproj.io/sync-wave': '20',
                            'argocd.argoproj.io/hook-delete-policy': 'BeforeHookCreation,HookSucceeded'})
    return item


def compile_videoq(directory, manifest, verified, public_url, storage_gib, listen_ip):
    application, inference = verified
    example = ROOT / 'charts/videoq/examples/single-node'
    _, infra = backing_plan(example, public_url, storage_gib,
                           read_documents((example / 'infrastructure.yaml').read_text()), tls_mode='internal')
    config, _ = backing_plan(example, public_url, storage_gib, [], tls_mode='internal')
    infra.append({'apiVersion': 'v1', 'kind': 'ConfigMap', 'metadata': {'name': 'videoq-infra-config'}, 'data': config})
    for item in infra:
        if item['kind'] == 'Deployment' and item['metadata']['name'] == 'videoq-gateway':
            for port in item['spec']['template']['spec']['containers'][0]['ports']:
                if port['containerPort'] == 443:
                    port.update({'hostPort': 443, 'hostIP': listen_ip})
    # local-path waits for a consuming Pod before binding. Keep this claim in
    # the model wave or Argo waits for Bound before creating its consumer.
    model_claim = {'apiVersion': 'v1', 'kind': 'PersistentVolumeClaim', 'metadata': {'name': 'videoq-gpt-oss-4090'},
                  'spec': {'accessModes': ['ReadWriteOnce'], 'storageClassName': 'local-path',
                           'resources': {'requests': {'storage': '20Gi'}}}}
    objects = [order(item, 0) for item in infra]
    objects.append(order(model_claim, 10))
    script = (ROOT / 'infra/garage/init.py').read_text()
    objects.append(order({'apiVersion': 'v1', 'kind': 'ConfigMap', 'metadata': {'name': 'videoq-storage-init'},
                          'data': {'init.py': script}}, 0))
    worker = manifest['images']['worker']
    job = {'apiVersion': 'batch/v1', 'kind': 'Job', 'metadata': {'name': 'videoq-storage-init', 'annotations': {
        'argocd.argoproj.io/hook': 'Sync', 'argocd.argoproj.io/hook-delete-policy': 'BeforeHookCreation,HookSucceeded'}},
        'spec': {'backoffLimit': 2, 'activeDeadlineSeconds': 600, 'template': {'spec': {
            'restartPolicy': 'Never', 'automountServiceAccountToken': False,
            'containers': [{'name': 'init', 'image': worker['repository'] + '@' + worker['digest'],
                'command': ['python', '/scripts/init.py'], 'envFrom': [{'secretRef': {'name': 'videoq-garage'}}],
                'volumeMounts': [{'name': 'script', 'mountPath': '/scripts', 'readOnly': True}]}],
            'volumes': [{'name': 'script', 'configMap': {'name': 'videoq-storage-init'}}]}}}}
    objects.append(order(job, 10))
    charts = manifest['charts']
    inference = deep_merge(inference, {'requireImageDigests': True, 'servers': {'chat': {
        'persistence': {'existingClaim': 'videoq-gpt-oss-4090'}}}})
    models = render(directory / charts['inference']['name'], 'inference', inference,
                    [ROOT / 'charts/videoq-inference/examples/rtx4090-gpt-oss-embeddinggemma.yaml'])
    objects += [order(item, 10) for item in models]
    values = deep_merge(application_values(public_url), yaml.safe_load((ROOT / 'charts/videoq/examples/local-ai-gpt-oss.yaml').read_text()))
    values = deep_merge(values, application)
    objects += [order(item, 30) for item in render(directory / charts['application']['name'], 'videoq', values)]
    validate_resources(objects)
    return objects


def validate_resources(objects):
    identities = set()
    for item in objects:
        identity = (item['apiVersion'], item['kind'], item['metadata']['name'])
        if identity in identities or item['kind'] in ('Secret', 'Namespace'):
            raise ValueError('Duplicate, secret or cluster-scoped application resource')
        identities.add(identity)
        spec = item.get('spec', {})
        if item['kind'] == 'Service' and (spec.get('type', 'ClusterIP') != 'ClusterIP' or spec.get('externalIPs')):
            raise ValueError('Application services must remain private ClusterIP services')
        pod = spec.get('template', {}).get('spec', {})
        if item['kind'] == 'CronJob':
            pod = spec['jobTemplate']['spec']['template']['spec']
        for container in pod.get('containers', []) + pod.get('initContainers', []):
            if not re.search(r'@sha256:[a-f0-9]{64}$', container['image']):
                raise ValueError('Every image must be fixed by digest')


def compile_gpu(pins):
    pin = pins['device_plugin']
    raw = urllib.request.urlopen(pin['url'], timeout=60).read()
    if hashlib.sha256(raw).hexdigest() != pin['sha256']:
        raise ValueError('Upstream device plugin checksum mismatch')
    daemon = yaml.safe_load(raw)
    daemon['metadata']['namespace'] = 'videoq-gpu'
    pod = daemon['spec']['template']['spec']
    pod['runtimeClassName'] = 'nvidia'
    pod['automountServiceAccountToken'] = False
    pod['nodeSelector'] = {'videoq.io/inference-target': 'rtx4090'}
    # system-node-critical is reserved for system namespaces; this app has its own namespace.
    pod.pop('priorityClassName', None)
    pod['containers'][0]['image'] = pin['image']
    pod['containers'][0]['args'] = ['--config-file=/config/config.yaml']
    pod['containers'][0]['volumeMounts'].append({'name': 'config', 'mountPath': '/config', 'readOnly': True})
    pod['volumes'].append({'name': 'config', 'configMap': {'name': 'nvidia-time-slicing'}})
    values = yaml.safe_load((ROOT / 'charts/videoq-inference/examples/rtx4090-device-plugin.yaml').read_text())
    config = {'apiVersion': 'v1', 'kind': 'ConfigMap', 'metadata': {'name': 'nvidia-time-slicing', 'namespace': 'videoq-gpu'},
              'data': {'config.yaml': values['config']['map']['rtx4090']}}
    # Changing the plugin config must restart the DaemonSet.
    daemon['spec']['template']['metadata'].setdefault('annotations', {})['videoq.jp/config-hash'] = hashlib.sha256(
        config['data']['config.yaml'].encode()).hexdigest()
    return [config, daemon]


def application(name, project, repository, revision, path, namespace):
    return {'apiVersion': 'argoproj.io/v1alpha1', 'kind': 'Application',
            'metadata': {'name': name, 'namespace': 'argocd'}, 'spec': {
                'project': project, 'source': {'repoURL': repository, 'targetRevision': revision,
                    'path': path},
                'destination': {'server': 'https://kubernetes.default.svc', 'namespace': namespace},
                'syncPolicy': {'syncOptions': ['FailOnSharedResource=true']}}}


def deployment_pin(path, manifest, run_id, attempt):
    """Export public image identities so cleanup never needs private repo access."""
    previous = []
    if path.exists():
        data = json.loads(path.read_text())
        if data.get('schemaVersion') != 1 or not isinstance(data.get('generations'), list) or not 1 <= len(data['generations']) <= 2:
            raise ValueError('Invalid existing deployment pins')
        previous = data['generations']
    current = {'sourceSha': manifest['sourceSha'], 'runId': str(run_id), 'runAttempt': attempt,
               'images': {name: {'repository': image['repository'], 'digest': image['digest']}
                          for name, image in manifest['images'].items()}}
    generations = [current] + [item for item in previous if item != current][:1]
    for item in generations:
        if (not re.fullmatch(r'[a-f0-9]{40}', item.get('sourceSha', '')) or
                not re.fullmatch(r'[1-9][0-9]*', str(item.get('runId', ''))) or
                not isinstance(item.get('runAttempt'), int) or item['runAttempt'] < 1 or
                set(item.get('images', {})) != {'api', 'worker', 'web', 'transcription-gateway'}):
            raise ValueError('Invalid protected generation identity')
        for component, image in item['images'].items():
            if image.get('repository') != 'ghcr.io/videoq-jp/videoq-' + component or not re.fullmatch(r'sha256:[a-f0-9]{64}', image.get('digest', '')):
                raise ValueError('Invalid protected image identity')
    return {'schemaVersion': 1, 'generations': generations}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release-directory', required=True, type=Path)
    parser.add_argument('--source-sha', required=True)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--run-attempt', required=True, type=int)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--revision', default='main')
    parser.add_argument('--site', default='lab')
    parser.add_argument('--public-url', required=True)
    parser.add_argument('--listen-ip', required=True)
    parser.add_argument('--storage-gib', default=40, type=int)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--deployment-pin-output', required=True, type=Path,
                        help='Public application-repository .github/deployment-pins/SITE.json; merge before activating the private config change')
    args = parser.parse_args()
    import ipaddress
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,30}', args.site):
        raise ValueError('Invalid site name')
    if not re.fullmatch(r'(https://github.com/|git@github.com:)[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+[.]git', args.repository):
        raise ValueError('A GitHub repository URL without credentials is required')
    address = ipaddress.ip_address(args.listen_ip)
    if address.version != 4 or address.is_unspecified or address.is_loopback or not address.is_private:
        raise ValueError('Bind HTTPS to the dedicated host LAN IPv4 address')
    checked_source(args.source_sha)
    selected = {'source_sha': args.source_sha, 'run_id': args.run_id, 'run_attempt': args.run_attempt}
    public_release.check_run(selected)
    verified = public_release.public_verifier.verify(args.release_directory, args.source_sha, args.run_id, args.run_attempt)
    manifest = public_release.public_verifier.manifest.validate(json.loads((args.release_directory / 'release.json').read_text()), args.source_sha)
    pins = json.loads((ROOT / 'infra/ansible/pins.json').read_text())
    # Complete verification and rendering before writing any output files.
    resources = compile_videoq(args.release_directory, manifest, verified, args.public_url, args.storage_gib, str(address))
    gpu = compile_gpu(pins)
    protected = deployment_pin(args.deployment_pin_output, manifest, args.run_id, args.run_attempt)
    root = args.output / 'clusters' / args.site
    files = {'videoq/resources.json': {'apiVersion': 'v1', 'kind': 'List', 'items': resources},
             'gpu/resources.json': {'apiVersion': 'v1', 'kind': 'List', 'items': gpu},
             'apps/gpu.json': application('lab-gpu', 'videoq-gpu', args.repository, args.revision, f'clusters/{args.site}/gpu', 'videoq-gpu'),
             'apps/videoq.json': application('lab-videoq', 'videoq-lab', args.repository, args.revision, f'clusters/{args.site}/videoq', 'videoq')}
    evidence = {'sourceSha': args.source_sha, 'runId': args.run_id, 'runAttempt': args.run_attempt,
                'releaseManifestSha256': hashlib.sha256((args.release_directory / 'release.json').read_bytes()).hexdigest(),
                'bootstrapPins': pins, 'publicUrl': args.public_url, 'listenIp': str(address),
                'renderedFilesSha256': {name: hashlib.sha256((json.dumps(value, indent=2) + '\n').encode()).hexdigest() for name, value in files.items()}}
    files['release-lock.json'] = evidence
    args.deployment_pin_output.parent.mkdir(parents=True, exist_ok=True)
    args.deployment_pin_output.write_text(json.dumps(protected, indent=2) + '\n')
    for name, value in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, indent=2) + '\n')
    print(f'Prepared {root}. Merge public deployment pins FIRST, then review the private configuration change. Nothing was deployed.')


if __name__ == '__main__':
    main()
