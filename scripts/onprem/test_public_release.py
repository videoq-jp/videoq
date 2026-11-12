"""Anonymous transport, immutable selection and fail-closed download tests."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, Mock, patch

import public_release as public

SOURCE = 'a' * 40
SELECTED = {'run_id': '123', 'source_sha': SOURCE, 'run_attempt': 2, 'tag': f'onprem-{SOURCE}-123-2'}


class PublicDownloadTests(unittest.TestCase):
    def test_public_api_request_never_uses_environment_credentials(self):
        response = MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = b'[]'
        with patch.dict('os.environ', {'GH_TOKEN': 'do-not-send', 'GITHUB_TOKEN': 'do-not-send'}), patch.object(public, 'urlopen', return_value=response) as open_url:
            public.read_url('https://api.github.com/repos/videoq-jp/videoq/releases')
        request = open_url.call_args.args[0]
        self.assertNotIn('Authorization', dict(request.header_items()))
        self.assertNotIn('do-not-send', str(request.header_items()))

    def test_catalog_accepts_only_public_exact_source_run_attempt_tags(self):
        good = {'tag_name': SELECTED['tag'], 'target_commitish': SOURCE, 'draft': False, 'prerelease': False}
        rows = [good, {**good, 'draft': True}, {**good, 'prerelease': True}, {**good, 'target_commitish': 'main'}, {**good, 'tag_name': 'v1.0.0'}]
        with patch.object(public, 'read_url', return_value=json.dumps(rows).encode()):
            self.assertEqual(public.releases(), [SELECTED])
        self.assertEqual(public.select([SELECTED], '123', SOURCE, 2), SELECTED)
        for values in [('999', None, None), ('123', 'b'*40, None), ('123', SOURCE, 1)]:
            with self.assertRaises(ValueError): public.select([SELECTED], *values)

    def test_saved_version_resolves_exact_tag_without_a_latest_catalog(self):
        row = {'tag_name': SELECTED['tag'], 'target_commitish': SOURCE, 'draft': False, 'prerelease': False}
        with patch.object(public, 'releases', side_effect=AssertionError('must not search latest')), patch.object(public, 'read_url', return_value=json.dumps(row).encode()) as read:
            self.assertEqual(public.catalog_for('123', SOURCE, 2), [SELECTED])
        self.assertTrue(read.call_args.args[0].endswith('/releases/tags/'+SELECTED['tag']))
        with self.assertRaises(ValueError): public.catalog_for('../evil', SOURCE, 2)

    def test_successful_main_run_is_required_and_cannot_be_substituted(self):
        good = {'conclusion': 'success', 'head_branch': 'main', 'head_sha': SOURCE, 'run_attempt': 2, 'repository': {'full_name': public.REPOSITORY}, 'path': '.github/workflows/onprem-release.yml'}
        with patch.object(public, 'read_url', return_value=json.dumps(good).encode()): public.check_run(SELECTED)
        for change in [{'conclusion': 'failure'}, {'head_branch': 'pr-branch'}, {'head_sha': 'b'*40}, {'run_attempt': 1}, {'path': '.github/workflows/attacker.yml'}, {'repository': {'full_name': 'attacker/videoq'}}]:
            with self.subTest(change=change), patch.object(public, 'read_url', return_value=json.dumps({**good, **change}).encode()), self.assertRaises(ValueError): public.check_run(SELECTED)

    def test_download_includes_all_bundles_and_never_trusts_verified_values_as_input(self):
        data = {'charts': {'application': {'name': f'videoq-0.1.0-sha.{SOURCE}.tgz'}, 'inference': {'name': f'videoq-inference-0.1.0-sha.{SOURCE}.tgz'}}, 'images': {'api': {}, 'worker': {}}}
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder)/'release'
            with patch.object(public.public_verifier.manifest, 'validate', return_value=data), patch.object(public, 'read_url', side_effect=lambda url, **kw: json.dumps(data).encode() if url.endswith('release.json') else b'fixture') as read:
                public.download(SELECTED, target)
            names = {p.name for p in target.iterdir()}
            self.assertEqual(names, set(public.public_verifier.required_files(data)))
            self.assertIn('release.sigstore.json', names)
            self.assertIn('api.sigstore.json', names)
            self.assertNotIn('verified-images.json', names)
            self.assertTrue(all('/releases/download/'+SELECTED['tag']+'/' in call.args[0] for call in read.call_args_list))

    def test_oversized_response_and_partial_download_cannot_install(self):
        response = MagicMock(); response.__enter__.return_value = response; response.read.return_value = b'oversized'
        with patch.object(public, 'urlopen', return_value=response), self.assertRaises(ValueError): public.read_url('https://example.test', limit=1)
        with tempfile.TemporaryDirectory() as folder:
            target=Path(folder)/'release'
            data={'charts': {}, 'images': {'api': {}}}
            with patch.object(public.public_verifier.manifest, 'validate', return_value=data), patch.object(public, 'read_url', side_effect=[json.dumps(data).encode(), ValueError('offline')]), self.assertRaises(ValueError): public.download(SELECTED,target)
            self.assertFalse(target.exists())


if __name__ == '__main__': unittest.main()
