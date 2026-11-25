from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]


class OpenSSLGraphTest(unittest.TestCase):
    def test_compiler_graph_is_shared_and_contains_all_security_inputs(self):
        graphs = []
        for component in ['api', 'web']:
            text = (ROOT / f'apps/{component}/Dockerfile').read_text()
            graph = text.split('# BEGIN shared OpenSSL security\n')[1].split('# END shared OpenSSL security')[0]
            graphs.append(graph)
            self.assertIn('COPY apps/security/openssl /build/openssl', graph)
            self.assertIn('MAKEFLAGS=-j4 abuild -F -d -r', graph)
            self.assertIn('cp /root/.abuild/*.pub /etc/apk/keys/', graph)
            self.assertIn('OPENSSL_SECURITY_REFRESH=', graph)
            for unrelated in ['COPY apps/api', 'COPY apps/web', 'VITE_', 'npm ci', 'FROM build']:
                self.assertNotIn(unrelated, graph)
            self.assertIn('apk add --no-network /tmp/security-packages/libcrypto3-3.5.9-r100.apk /tmp/security-packages/libssl3-3.5.9-r100.apk', text)
        self.assertEqual(graphs[0], graphs[1], 'Shared BuildKit graph must remain byte-identical')
