"""Actual public SLSA cryptography fixtures and hostile-input policy checks."""
import base64
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import onprem_public as public
SOURCE='2f9e90290f1edb1d904903458a592c0b87b1499b'
RUN='42505541209'
FIXTURE=Path(__file__).parent/'fixtures/onprem-public'


@unittest.skipUnless(importlib.util.find_spec('sigstore'), 'Install requirements-verify.txt')
class PublicSignatureTests(unittest.TestCase):
    def setUp(self):
        from sigstore.models import TrustedRoot
        from sigstore.verify import Verifier
        self.temporary=tempfile.TemporaryDirectory();self.addCleanup(self.temporary.cleanup)
        self.directory=Path(self.temporary.name)/'release'
        shutil.copytree(FIXTURE,self.directory)
        # Only tests use this fixed public root snapshot. Production always uses
        # Sigstore's independently updated production TUF configuration.
        verifier=Verifier(trusted_root=TrustedRoot.from_file(str(FIXTURE/'trusted-root.json')))
        self.production=patch.object(Verifier,'production',return_value=verifier)
        self.production.start();self.addCleanup(self.production.stop)

    def test_real_signatures_produce_digest_pinned_helm_values_without_cli(self):
        with patch.dict('os.environ',{'PATH':'/nonexistent','GH_TOKEN':'','GITHUB_TOKEN':''}):
            application,inference=public.verify(self.directory,SOURCE,RUN,1)
        self.assertTrue(application['requireImageDigests'])
        self.assertEqual(inference['vllm']['image']['digest'],'sha256:add0f47174d48caffdba80516f83cfa64ad1cccba95ce98437b83c7bd4c3cd83')

    def test_wrong_source_run_attempt_or_repository_cannot_reuse_valid_bundles(self):
        for source,run,attempt in [('a'*40,RUN,1),(SOURCE,'123',1),(SOURCE,RUN,2)]:
            with self.subTest(source=source,run=run,attempt=attempt),self.assertRaises(Exception): public.verify(self.directory,source,run,attempt)
        with self.assertRaises(ValueError): public.identity_policy(SOURCE,RUN,1,'attacker/videoq')

    def test_changed_payload_or_missing_signature_is_cryptographically_rejected(self):
        bundle=self.directory/'release.sigstore.json';original=bundle.read_text()
        for mutation in ('payload','signature'):
            data=json.loads(original)
            if mutation=='payload':
                statement=json.loads(base64.b64decode(data['dsseEnvelope']['payload']))
                statement['predicate']['buildDefinition']['internalParameters']['github']['runner_environment']='self-hosted'
                data['dsseEnvelope']['payload']=base64.b64encode(json.dumps(statement).encode()).decode()
            else: data['dsseEnvelope']['signatures'][0]['sig']=base64.b64encode(b'not-a-signature').decode()
            bundle.write_text(json.dumps(data))
            with self.assertRaises(Exception): public.verify(self.directory,SOURCE,RUN,1)
        bundle.write_text(original)

    def test_changed_chart_and_mismatched_component_bundle_are_rejected(self):
        manifest=json.loads((self.directory/'release.json').read_text())
        chart=self.directory/manifest['charts']['application']['name']
        original=chart.read_bytes();chart.write_bytes(b'tampered chart')
        with self.assertRaisesRegex(ValueError,'Chart bytes'): public.verify(self.directory,SOURCE,RUN,1)
        chart.write_bytes(original)
        (self.directory/'api.sigstore.json').write_bytes((self.directory/'worker.sigstore.json').read_bytes())
        with self.assertRaisesRegex(ValueError,'subject'): public.verify(self.directory,SOURCE,RUN,1)

    def test_signed_statement_requires_exact_workflow_hosted_runner_and_subject(self):
        bundle=json.loads((self.directory/'release.sigstore.json').read_text())
        payload=base64.b64decode(bundle['dsseEnvelope']['payload'])
        digest=public.hashlib.sha256((self.directory/'release.json').read_bytes()).hexdigest()
        public.check_statement('application/vnd.in-toto+json',payload,'release.json',digest,SOURCE,RUN,1)
        for change in ('runner','workflow','source','subject'):
            data=json.loads(payload)
            definition=data['predicate']['buildDefinition']
            if change=='runner':definition['internalParameters']['github']['runner_environment']='self-hosted'
            if change=='workflow':definition['externalParameters']['workflow']['path']='.github/workflows/attacker.yml'
            if change=='source':definition['resolvedDependencies'][0]['digest']['gitCommit']='a'*40
            if change=='subject':data['subject'][0]['digest']['sha256']='a'*64
            with self.assertRaises(ValueError):public.check_statement('application/vnd.in-toto+json',json.dumps(data),'release.json',digest,SOURCE,RUN,1)

    def test_verification_failure_preserves_existing_outputs_and_protects_bundles(self):
        first,second=self.directory/'values.json',self.directory/'inference.json'
        first.write_text('keep application');second.write_text('keep inference')
        argv=['onprem_public.py',SOURCE,RUN,'1',str(self.directory),str(first),str(second)]
        with patch('sys.argv',argv),patch.object(public,'verify',side_effect=ValueError('bad signature')),self.assertRaises(ValueError):public.main()
        self.assertEqual(first.read_text(),'keep application');self.assertEqual(second.read_text(),'keep inference')
        argv[-2]=str(self.directory/'release.sigstore.json')
        with patch('sys.argv',argv),patch.object(public,'verify') as verify,self.assertRaises(ValueError):public.main()
        verify.assert_not_called()


if __name__=='__main__':unittest.main()
