"""Headless Textual interaction tests; never provision a real machine."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

try:
    import rtx4090_tui as ui
    from textual.widgets import ContentSwitcher, Input, Static
except ImportError:
    ui = None


@unittest.skipIf(ui is None, 'Install requirements-tui.txt to test the Textual screens')
class TuiTests(unittest.IsolatedAsyncioTestCase):
    def make_app(self, folder, *extra):
        args = ui.rtx4090.parser().parse_args(['--directory', folder, '--url', 'https://192.168.10.20', '--username', 'yuki', '--email', 'yuki@example.com', *extra])
        return ui.VideoQInstaller(args, preview=True)

    async def review(self, app, pilot):
        app.query_one('#review-button').focus()
        await pilot.pause(0.3)
        await pilot.press('enter')
        await pilot.pause()

    async def test_keyboard_review_preview_completion_and_no_host_mutations(self):
        with tempfile.TemporaryDirectory() as folder:
            app = self.make_app(folder)
            with patch.object(ui.subprocess, 'run', side_effect=AssertionError('preview must not run host commands')):
                async with app.run_test(size=(120, 40)) as pilot:
                    self.assertGreater(app.query_one('#brand').content_region.height, 0)
                    await self.review(app, pilot)
                    self.assertEqual(app.query_one('#pages', ContentSwitcher).current, 'review')
                    self.assertEqual(app.plan.tls_mode, 'internal')
                    self.assertEqual(app.plan.listen_ip, '0.0.0.0')
                    await pilot.click('#start-button')
                    await pilot.pause()
                    self.assertEqual(app.query_one('#pages', ContentSwitcher).current, 'finished')
                    self.assertEqual(app.status, 0)
                    self.assertIn('root-ca.crt', str(app.query_one('#result', Static).render()))
                    self.assertFalse(list(Path(folder).iterdir()))

    async def test_email_error_is_inline_and_narrow_keyboard_navigation_works(self):
        with tempfile.TemporaryDirectory() as folder:
            app = self.make_app(folder, '--email', 'invalid')
            async with app.run_test(size=(80, 24)) as pilot:
                self.assertTrue(app.has_class('compact'))
                await self.review(app, pilot)
                self.assertEqual(app.query_one('#pages', ContentSwitcher).current, 'settings')
                self.assertIn('メール', str(app.query_one('#form-error', Static).render()))
                app.query_one('#email', Input).value = 'fixed@example.com'
                await self.review(app, pilot)
                self.assertEqual(app.query_one('#pages', ContentSwitcher).current, 'review')

    async def test_error_result_can_show_logs_and_return_to_settings(self):
        with tempfile.TemporaryDirectory() as folder:
            app = self.make_app(folder)
            async with app.run_test(size=(120, 40)) as pilot:
                await self.review(app, pilot)
                app.receive_line('4/8 model boot')
                app.show_result(False, 'Test failure; data preserved')
                await pilot.pause()
                await pilot.click('#view-logs')
                self.assertEqual(app.query_one('#pages', ContentSwitcher).current, 'installing')
                app.query_one('#return-result').focus()
                await pilot.pause()
                await pilot.press('enter')
                await pilot.click('#retry-button')
                self.assertEqual(app.query_one('#pages', ContentSwitcher).current, 'settings')
                self.assertEqual(app.status, 1)

    async def test_passwords_are_masked_cleared_and_absent_from_process_arguments(self):
        with tempfile.TemporaryDirectory() as folder:
            app = self.make_app(folder)
            async with app.run_test(size=(120, 40)) as pilot:
                await self.review(app, pilot)
                app.preview = False
                app.show_result(True, '')
                secret = 'private-example-password'
                first, second = app.query_one('#password', Input), app.query_one('#password-confirm', Input)
                self.assertTrue(first.password and second.password)
                first.value = second.value = secret
                with patch.object(app, 'save_password') as save:
                    app.query_one('#password-button').focus()
                    await pilot.pause()
                    await pilot.press('enter')
                    save.assert_called_once_with(secret)
                self.assertEqual(first.value + second.value, '')
                self.assertNotIn(secret, str(ui.arguments(app.plan)))
                app.running = False

    async def test_install_worker_runs_plain_backend_without_interactive_stdin(self):
        from unittest.mock import MagicMock
        with tempfile.TemporaryDirectory() as folder:
            app = self.make_app(folder)
            async with app.run_test(size=(120, 40)) as pilot:
                await self.review(app, pilot)
                app.preview = False
                child = MagicMock()
                child.__enter__.return_value = child
                child.stdout = iter(['1/8 check host\n', '4/8 models\n', '8/8 admin\n'])
                child.wait.return_value = 0
                (Path(folder) / 'installation.json').write_text(json.dumps({'complete': True, 'url': app.plan.url}))
                with patch.object(ui.subprocess, 'Popen', return_value=child) as process:
                    app.page('installing', 3)
                    app.install_worker()
                    await app.workers.wait_for_complete()
                    await pilot.pause()
                self.assertIn('--no-tui', process.call_args.args[0])
                self.assertEqual(process.call_args.kwargs['stdin'], ui.subprocess.DEVNULL)
                self.assertEqual(process.call_args.kwargs['env']['VIDEOQ_NONINTERACTIVE'], '1')
                self.assertEqual(app.query_one('#pages', ContentSwitcher).current, 'finished')
                self.assertEqual(app.status, 0)

    async def test_multiple_lan_candidates_are_selectable_without_mutating_state(self):
        with tempfile.TemporaryDirectory() as folder:
            args = ui.rtx4090.parser().parse_args(['--directory', folder])
            with patch.object(ui, 'lan_addresses', return_value=[('10.0.1.2', 'ens3'), ('192.168.10.20', 'ens4')]):
                app = ui.VideoQInstaller(args, preview=True)
            async with app.run_test(size=(120, 40)) as pilot:
                self.assertEqual(app.query_one('#url', Input).value, '')
                app.query_one('#lan-choice').value = 'https://192.168.10.20'
                await pilot.pause()
                self.assertEqual(app.query_one('#url', Input).value, 'https://192.168.10.20')
                self.assertFalse(list(Path(folder).iterdir()))


if __name__ == '__main__': unittest.main()
