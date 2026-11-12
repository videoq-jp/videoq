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


def lab_registry_mirror(existing):
    config = copy.deepcopy({} if existing is None else existing)
    if not isinstance(config, dict):
        raise ValueError('Registry configuration must be a mapping')
    mirrors = config.setdefault('mirrors', {})
    if not isinstance(mirrors, dict):
        raise ValueError('Registry mirrors must be a mapping')
    ghcr = mirrors.setdefault('ghcr.io', {})
    if not isinstance(ghcr, dict) or ghcr.get('rewrite'):
        raise ValueError('Review existing GHCR rewrites before adding the lab store')
    endpoints = ghcr.get('endpoint', [])
    if not isinstance(endpoints, list) or any(not isinstance(e, str) for e in endpoints):
        raise ValueError('Registry endpoints must be a list of URLs')
    ghcr['endpoint'] = list(dict.fromkeys(['http://127.0.0.1:5000', *endpoints]))
    return config


class FilterModule:
    def filters(self):
        return {'pin_argocd_manifest': pin_argocd_manifest, 'videoq_repository': validate_repository, 'lab_registry_mirror': lab_registry_mirror}
