"""Restore a validated cold snapshot into a quiesced native installation."""
import json
from pathlib import Path, PurePosixPath
import secrets
import subprocess
import tarfile

from common import INFRA
from lifecycle import BACKENDS, DATA_PVCS, WRITERS, verify_backup


def inspect_archive(path):
    roots, total = set(), 0
    with tarfile.open(path, 'r|gz') as archive:
        for entry in archive:
            name = PurePosixPath(entry.name)
            if entry.name in ('.', './') and entry.isdir():
                continue
            if name.is_absolute() or '..' in name.parts or not name.parts or name.parts[0] not in DATA_PVCS:
                raise ValueError('Snapshot contains a path outside the four data volumes')
            if not (entry.isdir() or entry.isfile()):
                raise ValueError('Snapshot contains a link or special file; manual recovery is required')
            if len(name.parts) == 1:
                if not entry.isdir():
                    raise ValueError('Snapshot volume root must be a directory')
                roots.add(name.parts[0])
            total += entry.size
    if roots != set(DATA_PVCS):
        raise ValueError('Snapshot does not contain all four data volumes')
    return total


def restore_cold_data(instance, directory):
    """Fail before deleting data unless archive, cluster and quiescence are proven.

    The transaction journal must already contain rolling_back. Repeating this
    operation after interruption is safe while every writer/backend remains off.
    This restores data only; the caller must restore credentials and old workloads
    and pass old-release health checks before admitting traffic.
    """
    directory = Path(directory)
    manifest = verify_backup(directory)
    inspect_archive(directory / 'volumes.tar.gz')
    instance.check_cluster_identity()
    workloads = json.loads(instance.kube('get', 'deployments', *WRITERS, *BACKENDS,
                                        '-o', 'json', capture=True))['items']
    if {obj['metadata']['name'] for obj in workloads} != set(WRITERS + BACKENDS):
        raise ValueError('Missing workloads; cannot prove cold restore is safe')
    for obj in workloads:
        if obj['spec'].get('replicas', 1) != 0:
            raise ValueError('Every writer and backend must be stopped before restoring data')
        selector = ','.join(k + '=' + v for k, v in sorted(obj['spec']['selector']['matchLabels'].items()))
        pods = json.loads(instance.kube('get', 'pods', '-l', selector, '-o', 'json', capture=True))['items']
        if pods:
            raise ValueError('A writer/backend Pod is still present; no data was deleted')
    claims = json.loads(instance.kube('get', 'pvc', *DATA_PVCS, '-o', 'json', capture=True))['items']
    if ({obj['metadata']['name'] for obj in claims} != set(DATA_PVCS)
            or any(obj.get('status', {}).get('phase') != 'Bound' for obj in claims)):
        raise ValueError('All four original PVCs must be bound before restoring')
    identities = manifest.get('pvcUids', {})
    if (set(identities) != set(DATA_PVCS)
            or any(not identities.get(obj['metadata']['name'])
                   or identities[obj['metadata']['name']] != obj['metadata'].get('uid') for obj in claims)):
        raise ValueError('PVC identities differ from the cold snapshot; no data was deleted')
    name = 'videoq-restore-' + secrets.token_hex(6)
    instance.apply({'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {'name': name}, 'spec': {
        'restartPolicy': 'Never', 'automountServiceAccountToken': False,
        'containers': [{'name': 'restore', 'image': INFRA['postgres'], 'command': ['sleep', '3600'],
            'securityContext': {'runAsUser': 0, 'allowPrivilegeEscalation': False,
                                'capabilities': {'drop': ['ALL'], 'add': ['DAC_OVERRIDE', 'FOWNER', 'CHOWN']}},
            'resources': {'requests': {'cpu': '25m', 'memory': '32Mi'}, 'limits': {'memory': '128Mi'}},
            'volumeMounts': [{'name': claim, 'mountPath': '/restore/' + claim} for claim in DATA_PVCS]}],
        'volumes': [{'name': claim, 'persistentVolumeClaim': {'claimName': claim}} for claim in DATA_PVCS]}})
    try:
        instance.kube('wait', '--for=condition=Ready', 'pod/' + name, '--timeout=300s')
        # Fixed mount paths only. The archive has already been fully inspected;
        # no symlink, hardlink, device, absolute or parent traversal is permitted.
        script = '\n'.join('find /restore/' + claim + ' -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +' for claim in DATA_PVCS)
        instance.kube('exec', name, '--', 'sh', '-ec', script)
        with (directory / 'volumes.tar.gz').open('rb') as stream:
            subprocess.run(['kubectl', '--kubeconfig', str(instance.kubeconfig), '-n',
                            getattr(instance, 'namespace', 'videoq'), 'exec', '-i', name, '--',
                            'tar', '-xzpf', '-', '--numeric-owner', '-C', '/restore'], stdin=stream, check=True)
    finally:
        instance.kube('delete', 'pod', name, '--ignore-not-found=true', '--wait=true')
    return manifest
