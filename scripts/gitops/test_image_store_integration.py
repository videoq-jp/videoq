"""Real OCI transfer and source-loss acceptance; opt in on a Docker host."""
import json
import os
from pathlib import Path
import subprocess
import uuid
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
                command('docker', 'rm', '-f', names[1])
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
            for name in created: command('docker', 'rm', '-f', name)
            command('docker', 'volume', 'rm', volume)


if __name__ == '__main__': unittest.main()
