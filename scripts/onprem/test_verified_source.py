from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import verified_source as module


class VerifiedSourceTests(unittest.TestCase):
    def selection(self):
        sha = 'a' * 40
        return {'source_sha': sha, 'run_id': '12', 'run_attempt': 1,
                'tag': f'onprem-{sha}-12-1'}

    def test_invalid_release_identity_cannot_create_paths_or_start_a_verifier(self):
        for key, value in (('source_sha', '../escape'), ('run_id', '../escape'),
                           ('run_attempt', True), ('tag', 'main')):
            with self.subTest(key=key), tempfile.TemporaryDirectory() as folder:
                selection = self.selection()
                selection[key] = value
                cache = Path(folder) / 'cache'
                with patch.object(module.public_release, 'check_run') as check, self.assertRaises(ValueError):
                    module.fetch_verified_source(selection, cache)
                check.assert_not_called()
                self.assertFalse(cache.exists())

    def test_failed_signature_never_fetches_or_executes_candidate_code(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(module.public_release, 'check_run'), patch.object(module.public_release, 'download'), \
                    patch.object(module.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'verifier')), \
                    patch.object(module, 'git') as git:
                with self.assertRaises(subprocess.CalledProcessError):
                    module.fetch_verified_source(self.selection(), folder)
                git.assert_not_called()
                self.assertEqual(list(Path(folder).iterdir()), [])

    def fixture_repository(self, folder):
        repo = Path(folder) / 'repo'
        subprocess.run(['git', 'init', '--quiet', '--initial-branch=main', str(repo)], check=True)
        (repo / 'update.py').write_text('print("verified source fixture")\n')
        subprocess.run(['git', '-C', str(repo), 'add', 'update.py'], check=True)
        subprocess.run(['git', '-C', str(repo), '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
                        'commit', '--quiet', '-m', 'fixture'], check=True)
        sha = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
        return repo, sha

    def test_real_git_checkout_rejects_modified_tracked_or_untracked_code(self):
        with tempfile.TemporaryDirectory() as folder:
            repo, sha = self.fixture_repository(folder)
            module.check_checkout(repo, sha)
            with self.assertRaisesRegex(ValueError, 'verified source commit'):
                module.check_checkout(repo, 'b'*40)
            original = (repo / 'update.py').read_text()
            (repo / 'update.py').write_text('print("modified")\n')
            with self.assertRaisesRegex(ValueError, 'modified'):
                module.check_checkout(repo, sha)
            (repo / 'update.py').write_text(original)
            (repo / 'injected.py').write_text('print("injected")\n')
            with self.assertRaisesRegex(ValueError, 'modified'):
                module.check_checkout(repo, sha)

    def test_symbolic_source_cache_is_not_executable(self):
        with tempfile.TemporaryDirectory() as folder:
            repo, sha = self.fixture_repository(folder)
            link = Path(folder) / 'linked'
            link.symlink_to(repo, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'Invalid installer'):
                module.check_checkout(link, sha)


if __name__ == '__main__':
    unittest.main()
