"""Verify upstream bytes and pin its reviewed serving images before applying."""
import copy
import hashlib
import json
import re
import yaml
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts/gitops"))
from repository import validate_repository


def pin_argocd_manifest(raw, pin, known_hosts=None):
    if hashlib.sha256(raw.encode()).hexdigest() != pin['sha256']:
        raise ValueError('Upstream Argo CD manifest checksum mismatch')
    objects = [copy.deepcopy(item) for item in yaml.safe_load_all(raw) if item]
    used = set()
    for item in objects:
        if (known_hosts is not None and item.get('kind') == 'ConfigMap'
                and item.get('metadata', {}).get('name') == 'argocd-ssh-known-hosts-cm'):
            # Keep operator-added host trust when comparing/reapplying upstream.
            # Applying the upstream defaults would remove keys or conflict with
            # the field manager that registered the internal Git server.
            item.setdefault('data', {})['ssh_known_hosts'] = known_hosts
        if item.get('kind') == 'ConfigMap' and item.get('metadata', {}).get('name') == 'argocd-cm':
            # Preserve Helm release labels used by Service/NetworkPolicy selectors.
            # Application names deliberately differ from the Helm release names.
            item.setdefault('data', {})['application.resourceTrackingMethod'] = 'annotation'
        pod = item.get('spec', {}).get('template', {}).get('spec', {})
        for container in pod.get('containers', []) + pod.get('initContainers', []):
            image = container['image']
            pinned = pin['images'].get(image)
            if not pinned or not re.search(r'@sha256:[a-f0-9]{64}$', pinned):
                raise ValueError('Unreviewed Argo CD image')
            container['image'] = pinned
            used.add(image)
    if used != set(pin['images']):
        raise ValueError('Argo CD image inventory changed')
    return json.dumps({'apiVersion': 'v1', 'kind': 'List', 'items': objects})


class FilterModule:
    def filters(self):
        return {'pin_argocd_manifest': pin_argocd_manifest, 'videoq_repository': validate_repository}
