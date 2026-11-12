"""Verify upstream bytes and pin its reviewed serving images before applying."""
import copy
import hashlib
import json
import re
import yaml


def pin_argocd_manifest(raw, pin):
    if hashlib.sha256(raw.encode()).hexdigest() != pin['sha256']:
        raise ValueError('Upstream Argo CD manifest checksum mismatch')
    objects = [copy.deepcopy(item) for item in yaml.safe_load_all(raw) if item]
    used = set()
    for item in objects:
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
        return {'pin_argocd_manifest': pin_argocd_manifest}
