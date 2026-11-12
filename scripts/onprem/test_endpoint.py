"""Automatic lab endpoint, explicit TLS setup, state preservation and real PEM checks."""
import contextlib
import io
import json
from pathlib import Path
import shutil
import ssl
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import endpoint
from k3s import EXAMPLE
from native import backing_plan, forwarding_units, gateway_config


class EndpointTests(unittest.TestCase):

    def test_openssl_zero_exit_on_mismatch_does_not_accept_a_certificate(self):
        for host, label in [('192.168.10.21', 'IP'), ('::1', 'IP'), ('videoq.example', 'Hostname')]:
            for output, code, accepted in [(f'{label} {host} does match certificate\n', 0, True),
                    (f'{label} {host} does NOT match certificate\n', 0, False),
                    ('', 0, False), (f'{label} {host} does match certificate\n', 1, False)]:
                with self.subTest(host=host, output=output, code=code), patch.object(endpoint.subprocess, 'run',
                        return_value=subprocess.CompletedProcess([], code, output, '')):
                    if accepted:
                        endpoint.require_certificate_hostname(Path('certificate.pem'), host)
                    else:
                        with self.assertRaises(ValueError):
                            endpoint.require_certificate_hostname(Path('certificate.pem'), host)

    def test_private_canary_keeps_the_browser_hostname_and_tls_validation(self):
        from urllib.request import Request
        import socket
        opener = endpoint.verified_opener(connect_ip='10.42.0.99')
        handler = next(item for item in opener.handlers if type(item).__name__ == 'CanaryHandler')
        captured = []
        def open_connection(factory, request, **kwargs):
            connection = factory('videoq.lab.example:443', **kwargs)
            captured.append(connection)
            return connection
        with patch.object(handler, 'do_open', side_effect=open_connection):
            connection = handler.https_open(Request('https://videoq.lab.example/ready'))
        self.assertEqual(connection.host, 'videoq.lab.example')
        self.assertTrue(connection._context.check_hostname)
        self.assertEqual(connection._context.verify_mode, ssl.CERT_REQUIRED)
        with patch.object(socket, 'create_connection') as connect:
            connection._create_connection(('videoq.lab.example', 443), 5)
        connect.assert_called_once_with(('10.42.0.99', 443), 5, None)
        with self.assertRaises(ValueError):
            endpoint.verified_opener(connect_ip='untrusted.example')







    def test_bad_urls_addresses_and_private_acme_are_rejected(self):
        for url in ['https://0.0.0.0', 'https://224.0.0.1', 'https://999.1.1.1', 'https://192.168.1.1:8443', 'https://evil;command', 'https://lab/path', 'http://lab']:
            with self.subTest(url=url), self.assertRaises(ValueError): endpoint.https_origin(url)
        for ip in ['example.com', '1.2.3.4\nExecStart=sh', '::', '224.1.1.1']:
            with self.assertRaises(ValueError): endpoint.listen_ip(ip)

    def test_provided_secret_mount_is_readonly_and_nonroot_readable(self):
        raw = [{'kind': 'Deployment', 'metadata': {'name': 'videoq-gateway'}, 'spec': {'template': {'metadata': {}, 'spec': {'containers': [{}]}}}}]
        config, objects = backing_plan(EXAMPLE, 'https://192.168.10.20', 40, raw, 'provided')
        pod = objects[0]['spec']['template']['spec']
        self.assertIn('tls /etc/videoq-tls/tls.crt /etc/videoq-tls/tls.key', config['Caddyfile'])
        self.assertTrue(pod['containers'][0]['volumeMounts'][0]['readOnly'])
        self.assertEqual(pod['volumes'][0]['secret']['defaultMode'], 0o440)
        self.assertEqual(pod['securityContext']['fsGroup'], 10001)


    def test_storage_probe_uses_the_same_verified_tls_client(self):
        import base64
        from types import SimpleNamespace
        from unittest.mock import MagicMock
        from k3s import Installer
        payload = b'videoq-tls-check'
        probe = {'payload': base64.b64encode(payload).decode(), 'put': 'https://192.168.10.20/videoq-media/check', 'get': 'https://192.168.10.20/videoq-media/check', 'key': 'check'}
        responses = []
        for status, body in [(200, b''), (200, payload), (206, payload[:6])]:
            response = MagicMock()
            response.__enter__.return_value = response
            response.status = status
            response.read.return_value = body
            response.headers = {'Content-Security-Policy': 'sandbox', 'X-Content-Type-Options': 'nosniff'}
            responses.append(response)
        instance = SimpleNamespace(kube=Mock(side_effect=[json.dumps(probe), '']), public_urlopen=Mock(side_effect=responses))
        with patch('k3s.urlopen', side_effect=AssertionError('must use explicit CA trust')), contextlib.redirect_stdout(io.StringIO()):
            Installer.check_public_storage(instance)
        self.assertEqual(instance.public_urlopen.call_count, 3)
        self.assertIn('--cleanup', instance.kube.call_args.args)

    @unittest.skipUnless(shutil.which('openssl'), 'OpenSSL required')
    def test_real_certificate_validation_rejects_wrong_host_key_and_bad_ca(self):
        if not subprocess.check_output(['openssl', 'version'], text=True).startswith('OpenSSL 3.'):
            self.skipTest('Ubuntu uses OpenSSL 3; put Homebrew openssl@3 on PATH on macOS')
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            cert, key = folder/'fullchain.pem', folder/'private.pem'
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=VideoQ test', '-addext', 'subjectAltName=IP:192.168.10.20', '-keyout', str(key), '-out', str(cert)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            details = {'tls_mode': 'provided', 'tls_cert': str(cert), 'tls_key': str(key), 'tls_ca': str(cert)}
            target = folder/'state'
            endpoint.prepare_certificate(target, details, 'https://192.168.10.20')
            self.assertEqual((target/'tls/tls.key').stat().st_mode & 0o777, 0o600)
            self.assertEqual((target/'tls').stat().st_mode & 0o777, 0o700)
            before = (target/'tls/tls.key').read_bytes()
            with self.assertRaises(ValueError): endpoint.prepare_certificate(target, details, 'https://192.168.10.21')
            bad = folder/'bad.pem'; bad.write_text('not a private key or CA')
            for replacement in ({'tls_key': str(bad)}, {'tls_ca': str(bad)}):
                with self.assertRaises(ValueError): endpoint.prepare_certificate(target, {**details, **replacement}, 'https://192.168.10.20')
                self.assertEqual((target/'tls/tls.key').read_bytes(), before)
            cert.unlink(); key.unlink()
            endpoint.prepare_certificate(target, {'tls_mode': 'provided'}, 'https://192.168.10.20')
            opener = endpoint.verified_opener(target/'tls/ca.crt')
            handler = next(h for h in opener.handlers if hasattr(h, '_context'))
            self.assertTrue(handler._context.check_hostname)
            self.assertEqual(handler._context.verify_mode, ssl.CERT_REQUIRED)


if __name__ == '__main__': unittest.main()
