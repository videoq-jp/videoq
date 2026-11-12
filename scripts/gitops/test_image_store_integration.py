"""Real OCI transfer and source-loss acceptance; opt in on a Docker host."""
import json
import os
from pathlib import Path
import subprocess
import uuid
import tempfile
import time
import unittest
import urllib.request
from unittest.mock import patch

import image_store as m


@unittest.skipUnless(os.environ.get('VIDEOQ_IMAGE_STORE_INTEGRATION') == '1', 'Requires explicit Docker integration opt-in')
class ImageStoreIntegration(unittest.TestCase):
    def test_all_four_graphs_survive_source_loss_and_store_restart(self):
        pins = json.loads((Path(__file__).resolve().parents[2] / 'infra/ansible/pins.json').read_text())
        image = pins['image_store']['image']
        oras = os.environ['VIDEOQ_ORAS']
        real_run = subprocess.run
        def command(*args, **kw):
            return real_run(args, check=True, text=True, capture_output=True, timeout=300, **kw).stdout.strip()
        names = ['videoq-store-acceptance-source', 'videoq-store-acceptance-destination']
        # Never replace a container from another invocation or the user's work.
        for name in names:
            exists = real_run(['docker', 'container', 'inspect', name], capture_output=True).returncode == 0
            self.assertFalse(exists, 'Existing acceptance container must be inspected first: ' + name)
        created = []
        volume = 'videoq-store-acceptance-' + uuid.uuid4().hex
        command('docker', 'volume', 'create', volume)
        try:
            for name in names:
                options = ['--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '-v', volume + ':/var/lib/registry'] if name == names[1] else []
                command('docker', 'run', '-d', '--name', name, '-p', '127.0.0.1::5000', *options, image)
                created.append(name)
            endpoints = []
            for name in names:
                port = command('docker', 'port', name, '5000/tcp').split(':')[-1]
                endpoint = '127.0.0.1:' + port
                for _ in range(60):
                    try:
                        with urllib.request.urlopen('http://' + endpoint + '/v2/', timeout=2): break
                    except Exception: time.sleep(.5)
                else: self.fail('Registry did not start')
                endpoints.append(endpoint)
            source, destination = endpoints
            digest = image.split('@')[1]
            images = {n: {'repository': 'ghcr.io/videoq-jp/videoq-' + n, 'digest': digest} for n in m.COMPONENTS}
            for n in sorted(m.COMPONENTS):
                fixture_source = image if n == 'api' else source + '/videoq-jp/videoq-api@' + digest
                flags = [] if n == 'api' else ['--from-plain-http']
                command(oras, 'copy', *flags, '--to-plain-http', fixture_source, source + '/videoq-jp/videoq-' + n + ':fixture')
            transfers = []
            def transfer(args, **kw):
                if args[0] == oras and '--to-plain-http' in args and any(a.partition('/')[0] == 'ghcr.io' for a in args):
                    transfers.append(args)
                    args = [source + '/' + a.split('/', 1)[1] if a.partition('/')[0] == 'ghcr.io' else a for a in args]
                    args.insert(2, '--from-plain-http')
                return real_run(args, **kw)
            with patch.object(m, 'ORAS', oras), patch.object(m, 'REGISTRY', destination), patch.object(m.subprocess, 'run', side_effect=transfer):
                m.preserve(images)
                self.assertEqual(len(transfers), 4)
                command('docker', 'stop', names[0])
                transfers.clear()
                m.preserve(images)
                self.assertEqual(transfers, [])
                command('docker', 'rm', '-f', '-v', names[1])
                command('docker', 'run', '-d', '--name', names[1], '-p', '127.0.0.1::5000',
                        '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
                        '-v', volume + ':/var/lib/registry', image)
                # A recreated pod has no container filesystem from the old one.
                destination = '127.0.0.1:' + command('docker', 'port', names[1], '5000/tcp').split(':')[-1]
                m.REGISTRY = destination
                for _ in range(60):
                    try:
                        with urllib.request.urlopen('http://' + destination + '/v2/', timeout=2): break
                    except Exception: time.sleep(.5)
                else: self.fail('Restarted registry did not become ready')
                m.preserve(images)
                self.assertEqual(transfers, [])
        finally:
            for name in created: command('docker', 'rm', '-f', '-v', name)
            command('docker', 'volume', 'rm', volume)


@unittest.skipUnless(os.environ.get('VIDEOQ_K3S_IMAGE'), 'Requires pinned privileged K3s CPU integration opt-in')
class K3sImageStoreIntegration(unittest.TestCase):
    def test_cri_mirror_and_native_import_after_runtime_cache_removal(self):
        from jinja2 import Template
        import yaml
        root = Path(__file__).resolve().parents[2]
        pins = json.loads((root / 'infra/ansible/pins.json').read_text())
        image = pins['image_store']['image']
        name = 'videoq-store-k3s-acceptance'
        def command(*args, input=None):
            return subprocess.run(args, input=input, check=True, text=True, capture_output=True, timeout=240).stdout.strip()
        def node(*args, input=None): return command('docker', 'exec', '-i', name, *args, input=input)
        self.assertNotEqual(subprocess.run(['docker', 'inspect', name], capture_output=True).returncode, 0)
        with tempfile.TemporaryDirectory() as temporary:
            config = Path(temporary)
            (config / 'registries.yaml').write_text('mirrors:\n  ghcr.io:\n    endpoint: ["http://127.0.0.1:5000"]\n')
            created = False
            try:
                command('docker', 'run', '--privileged', '-d', '--name', name,
                        '--mount', 'type=bind,source=' + str(config) + ',target=/etc/rancher/k3s',
                        os.environ['VIDEOQ_K3S_IMAGE'], 'server', '--disable', 'traefik', '--disable', 'servicelb')
                created = True
                for _ in range(90):
                    try:
                        if json.loads(node('kubectl', 'get', 'nodes', '-o', 'json'))['items']: break
                    except (subprocess.CalledProcessError, ValueError): pass
                    time.sleep(1)
                node('kubectl', 'wait', '--for=condition=Ready', 'nodes', '--all', '--timeout=180s')
                version = json.loads(node('kubectl', 'version', '-o', 'json'))['serverVersion']['gitVersion']
                self.assertEqual(version, pins['k3s']['version'])
                arch = node('uname', '-m')
                platform = 'linux/' + {'aarch64': 'arm64', 'x86_64': 'amd64'}[arch]
                oras = os.environ.get('VIDEOQ_K3S_ORAS', os.environ['VIDEOQ_ORAS'])
                command('docker', 'cp', oras, name + ':/tmp/videoq-oras')
                node('mkdir', '-p', '/var/lib/videoq-image-store/registry')
                manifest = Template((root / 'infra/ansible/roles/lab/templates/image-registry.yaml.j2').read_text(), autoescape=True).render(image_store=pins['image_store'])
                node('kubectl', 'apply', '-f', '-', input=manifest)
                node('kubectl', '-n', 'kube-system', 'rollout', 'status', 'deployment/videoq-image-store', '--timeout=180s')
                source = 'ghcr.io/videoq-jp/videoq-api@' + image.split('@')[1]
                node('/tmp/videoq-oras', 'copy', '--to-plain-http', image,
                     '127.0.0.1:5000/videoq-jp/videoq-api:fixture')
                def pod(podname):
                    node('kubectl', 'run', podname, '--image=' + source, '--image-pull-policy=Always', '--restart=Never', '--command', '--', '/bin/registry', '--version')
                    node('kubectl', 'wait', '--for=jsonpath={.status.phase}=Succeeded', 'pod/' + podname, '--timeout=120s')
                pod('mirror-proof')
                node('kubectl', 'delete', 'pod', 'mirror-proof')
                node('crictl', 'rmi', source)
                pod('mirror-after-removal')
                # Use the production bootstrap pull arguments. The transfer path
                # can report success while compressed layers remain absent after
                # CRI cache removal; --local must rehydrate them before export.
                tasks = yaml.safe_load((root / 'infra/ansible/roles/lab/tasks/image-store.yml').read_text())
                block = next(t['block'] for t in tasks if t['name'] == 'Cache the upstream registry so it can start without an upstream pull')
                pull = next(t['ansible.builtin.command']['argv'] for t in block if t['name'] == 'Fetch the digest-pinned registry image')
                pull = [Template(a, autoescape=True).render(image_store=pins['image_store']) for a in pull[1:]]
                pull = [platform if a == 'linux/amd64' else a for a in pull]
                node(*pull)
                aliases = [m.archive_ref(ref) for ref in (image, source)]
                for ref, alias in zip((image, source), aliases): node('ctr', 'images', 'tag', '--force', ref, alias)
                node('ctr', 'images', 'export', '--platform', platform, '/tmp/videoq-store-proof.tar', *aliases)
                archive = '/var/lib/rancher/k3s/agent/images/videoq-store-proof.tar'
                node('mkdir', '-p', '/var/lib/rancher/k3s/agent/images')
                node('cp', '/tmp/videoq-store-proof.tar', archive + '.partial')
                node('mv', archive + '.partial', archive)
                for _ in range(60):
                    result = subprocess.run(['docker', 'logs', name], capture_output=True, text=True, check=True)
                    logs = result.stdout + result.stderr
                    if 'Imported 2 images from ' + archive in logs: break
                    time.sleep(.5)
                else: self.fail('Native K3s importer did not accept both digest-derived archive tags')
            finally:
                if created: command('docker', 'rm', '-f', '-v', name)


if __name__ == '__main__': unittest.main()
