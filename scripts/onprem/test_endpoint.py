"""Lab TLS dialog, state preservation and actual PEM validation."""
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
import rtx4090
from native import backing_plan, forwarding_units, gateway_config


class EndpointTests(unittest.TestCase):
    def args(self, *extra):
        return rtx4090.parser().parse_args(list(extra))

    def test_lab_wizard_defaults_to_ip_url_and_internal_ca(self):
        ask = Mock(side_effect=['192.168.10.20', '', ''])
        with contextlib.redirect_stdout(io.StringIO()):
            url, network = endpoint.network_details(self.args(), {}, ask)
        self.assertEqual(url, 'https://192.168.10.20')
        self.assertEqual(network, {'listen_ip': '192.168.10.20', 'tls_mode': 'internal'})
        self.assertEqual(ask.call_count, 3)
        config = gateway_config(url, 'internal')
        self.assertIn('tls internal', config)
        self.assertIn('default_sni 192.168.10.20', config)
        self.assertNotIn('issuer acme', config)
        self.assertIn('flush_interval -1', config)
        units = forwarding_units(443, '10.43.0.3', True, network['listen_ip'])
        self.assertIn('ListenStream=192.168.10.20:443', units['videoq-port-forward.socket'])

    def test_dns_name_and_bring_your_own_certificate_dialog(self):
        ask = Mock(side_effect=['', 'https://videoq.lab.example.ac.jp', '2', '/srv/fullchain.pem', '/srv/key.pem', ''])
        with contextlib.redirect_stdout(io.StringIO()):
            url, details = endpoint.network_details(self.args(), {}, ask)
        self.assertEqual(url, 'https://videoq.lab.example.ac.jp')
        self.assertEqual(details['tls_mode'], 'provided')
        self.assertEqual(details['tls_key'], '/srv/key.pem')
        self.assertNotIn('tls_ca', details)

    def test_resume_does_not_prompt_or_switch_method_or_listener(self):
        recorded = {'url': 'https://192.168.10.20', 'network': {'listen_ip': '192.168.10.20', 'tls_mode': 'internal'}}
        ask = Mock(side_effect=AssertionError('must not prompt'))
        self.assertEqual(endpoint.network_details(self.args(), recorded, ask), (recorded['url'], recorded['network']))
        for flags in [('--listen-ip', '0.0.0.0'), ('--tls-mode', 'acme')]:
            with self.assertRaises(ValueError): endpoint.network_details(self.args(*flags), recorded, ask)

    def test_bad_urls_addresses_and_private_acme_are_rejected(self):
        for url in ['https://0.0.0.0', 'https://224.0.0.1', 'https://999.1.1.1', 'https://192.168.1.1:8443', 'https://evil;command', 'https://lab/path', 'http://lab']:
            with self.subTest(url=url), self.assertRaises(ValueError): endpoint.https_origin(url)
        for ip in ['example.com', '1.2.3.4\nExecStart=sh', '::', '224.1.1.1']:
            with self.assertRaises(ValueError): endpoint.listen_ip(ip)
        with self.assertRaises(ValueError): endpoint.network_details(self.args('--url', 'https://192.168.1.1', '--tls-mode', 'acme'), {})
        with self.assertRaises(ValueError): endpoint.network_details(self.args('--url', 'http://localhost:8080', '--listen-ip', '0.0.0.0'), {})

    def test_provided_secret_mount_is_readonly_and_nonroot_readable(self):
        raw = [{'kind': 'Deployment', 'metadata': {'name': 'videoq-gateway'}, 'spec': {'template': {'metadata': {}, 'spec': {'containers': [{}]}}}}]
        config, objects = backing_plan(rtx4090.EXAMPLE, 'https://192.168.10.20', 40, raw, 'provided')
        pod = objects[0]['spec']['template']['spec']
        self.assertIn('tls /etc/videoq-tls/tls.crt /etc/videoq-tls/tls.key', config['Caddyfile'])
        self.assertTrue(pod['containers'][0]['volumeMounts'][0]['readOnly'])
        self.assertEqual(pod['volumes'][0]['secret']['defaultMode'], 0o440)
        self.assertEqual(pod['securityContext']['fsGroup'], 10001)

    def test_saved_lab_setup_resumes_without_prompts(self):
        with tempfile.TemporaryDirectory() as folder:
            args = self.args('--directory', folder, '--username', 'yuki', '--email', 'yuki@example.com')
            with patch('builtins.input', side_effect=['192.168.10.20', '', '1']), contextlib.redirect_stdout(io.StringIO()):
                instance = rtx4090.NativeInstaller(args)
            instance.lock.close()
            with patch('builtins.input', side_effect=AssertionError('must not prompt')):
                resumed = rtx4090.NativeInstaller(args)
            try:
                self.assertEqual(resumed.url, 'https://192.168.10.20')
                self.assertEqual(resumed.network['tls_mode'], 'internal')
            finally:
                resumed.lock.close()

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
            args = self.args('--directory', str(folder/'lab'), '--url', 'https://192.168.10.20', '--tls-mode', 'internal', '--username', 'yuki', '--email', 'yuki@example.com')
            instance = rtx4090.NativeInstaller(args)
            try:
                pem = (target/'tls/tls.crt').read_text()
                instance.kube = Mock(return_value=pem)
                instance.configure_trust()
                self.assertEqual((instance.directory/'tls/root-ca.crt').read_text(), pem)
                self.assertIn('/data/caddy/pki/authorities/local/root.crt', instance.kube.call_args.args)
                self.assertNotIn('root.key', str(instance.kube.call_args))
                (instance.directory/'tls/root-ca.crt').write_text('different recorded CA')
                with self.assertRaisesRegex(ValueError, '内部CA'):
                    instance.configure_trust()
            finally:
                instance.lock.close()
            opener = endpoint.verified_opener(target/'tls/ca.crt')
            handler = next(h for h in opener.handlers if hasattr(h, '_context'))
            self.assertTrue(handler._context.check_hostname)
            self.assertEqual(handler._context.verify_mode, ssl.CERT_REQUIRED)


if __name__ == '__main__': unittest.main()
