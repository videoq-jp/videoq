#!/usr/bin/env python3
"""VideoQ's beginner-friendly Textual front end for the native GPU installer."""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading

from textual import work
from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.theme import Theme
from textual.widgets import Button, Checkbox, Collapsible, ContentSwitcher, Footer, Input, Label, ProgressBar, RichLog, Select, Static

import rtx4090
from endpoint import lan_addresses, network_details, prepare_certificate

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'scripts/onprem/install-rtx4090.sh'
OPTIONS = ('directory', 'url', 'username', 'email', 'listen_ip', 'tls_mode', 'tls_cert', 'tls_key', 'tls_ca', 'run_id', 'source_sha', 'storage_gib')
FLAGS = ('adopt_existing', 'migrate_url', 'reset_admin_link')
ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
STAGES = ('環境の確認', '実行基盤の準備', 'AIモデルの起動', 'データ保存先の準備', 'VideoQの起動', 'HTTPSの接続確認', '管理者の準備')


def arguments(args):
    result = []
    for field in OPTIONS:
        value = getattr(args, field)
        if value is not None:
            result.extend(['--' + field.replace('_', '-'), str(value)])
    result.extend('--' + field.replace('_', '-') for field in FLAGS if getattr(args, field))
    return result


def validate_plan(args, state):
    """Validate before any privileged command; temporary PEM validation saves no setup."""
    args = copy.copy(args)
    admin = rtx4090.admin_details(args.username, args.email)
    args.username, args.email = admin['username'], admin['email']
    with contextlib.redirect_stdout(io.StringIO()):
        url, network = network_details(args, state, ask=lambda _: '')
    if not url.startswith('http://'):
        args.url = url
        args.listen_ip, args.tls_mode = network['listen_ip'], network['tls_mode']
    if network['tls_mode'] == 'provided':
        # A saved certificate can be reused on a resumed run.
        saved = Path(args.directory).expanduser() / 'tls'
        for field, name in (('tls_cert', 'tls.crt'), ('tls_key', 'tls.key'), ('tls_ca', 'ca.crt')):
            if field not in network and (saved / name).exists():
                network[field] = str(saved / name)
        with tempfile.TemporaryDirectory() as folder:
            prepare_certificate(folder, network, url)
    return args


class VideoQInstaller(App):
    TITLE = 'VideoQ セットアップ'
    CSS_PATH = 'rtx4090_tui.tcss'
    BINDINGS = [('ctrl+q', 'safe_quit', '終了'), ('ctrl+c', 'safe_quit', '終了'), ('f1', 'help', '操作ガイド')]

    def __init__(self, args, *, preview=False):
        super().__init__()
        self.args = args
        self.preview = preview
        state_file = Path(args.directory).expanduser() / 'installation.json'
        self.saved = json.loads(state_file.read_text()) if state_file.exists() else {}
        self.running = False
        self.plan = None
        self.status = 0
        self.needs_password = not self.saved.get('admin_password_set') or args.reset_admin_link
        self.register_theme(Theme(name='videoq', primary='#3159dc', secondary='#182c3b', accent='#c5ee90', background='#fbfcfa', surface='#ffffff', foreground='#182c3b', success='#247441', warning='#8a5a00', error='#b81924', dark=False))
        self.theme = 'videoq'
        network = self.saved.get('network', {})
        url = args.url or self.saved.get('pending_url') or self.saved.get('url')
        self.candidates = [] if url else lan_addresses()
        if not url and len(self.candidates) == 1:
            url = 'https://' + self.candidates[0][0]
        self.initial_url = url or ''
        self.initial_mode = args.tls_mode or network.get('tls_mode') or ('acme' if self.saved.get('url', '').startswith('https://') else 'internal')
        self.initial_ip = args.listen_ip or network.get('listen_ip', '0.0.0.0')

    def compose(self) -> ComposeResult:
        yield Static('▶  VideoQ    /    研究室向けセットアップ', id='brand')
        with Horizontal(id='workspace'):
            with Vertical(id='sidebar'):
                yield Label('はじめてでも、大丈夫。', classes='side-title')
                yield Static('必要なソフトと3つのAIを\nこのマシンにまとめて準備します。', classes='muted')
                yield Static('1  設定\n\n2  内容を確認\n\n3  導入状況\n\n4  使いはじめる', id='steps')
                yield Static('RTX 4090 × 1\nGPT-OSS 20B\nEmbeddingGemma 2\nWhisper turbo', classes='model-note')
            with ContentSwitcher(initial='settings', id='pages'):
                with VerticalScroll(id='settings'):
                    yield Label('VideoQを使う準備をしましょう', classes='heading')
                    yield Static('接続先とHTTPSは自動設定。管理者の情報を入力して、次へ進んでください。', classes='description')
                    if self.preview:
                        yield Static('プレビュー：ソフトのインストールやサーバーの変更は行いません。', classes='notice')
                    with Vertical(classes='card'):
                        yield Label('接続先はおまかせ', classes='card-title')
                        yield Static(self.initial_url or '接続先のIPを選択、または詳細設定でURLを入力してください。', id='auto-url', markup=False)
                        yield Static('', id='auto-details', classes='muted')
                        if len(self.candidates) > 1:
                            yield Label('複数のLANがあります。利用するIPを選択してください。')
                            yield Select([(f'{ip} ({name})', 'https://' + ip) for ip, name in self.candidates], prompt='IPを選択', id='lan-choice')
                    with Vertical(classes='card'):
                        yield Label('管理者アカウント', classes='card-title')
                        yield Label('ユーザー名（必須・英小文字／数字／_、3〜30文字）')
                        yield Input(value=self.args.username or self.saved.get('admin', {}).get('username', 'site_admin'), id='username')
                        yield Label('メールアドレス（必須）')
                        yield Input(value=self.args.email or self.saved.get('admin', {}).get('email', ''), placeholder='例：yuki@example.com', id='email')
                        yield Static('初回パスワードは導入完了後に設定します。メールは送信しません。', classes='muted')
                    with Collapsible(title='詳細設定を変更する（通常は不要）', id='advanced'):
                        yield Label('ブラウザ用URL')
                        yield Input(value=self.initial_url, placeholder='https://192.168.10.20', id='url')
                        yield Label('待受IPv4（IP固定・DHCP設定は変更しません）')
                        yield Input(value=self.initial_ip, id='listen-ip')
                        yield Label('証明書の方式')
                        modes = [('内部CA（研究室向け・標準）', 'internal'), ('大学などの持ち込み証明書', 'provided'), ('公開ACME（外部443番が必要）', 'acme'), ('SSH localhost（既存構成用）', 'none')]
                        yield Select(modes, value=self.initial_mode, allow_blank=False, id='tls-mode')
                        yield Label('持ち込みの場合：証明書PEM / 秘密鍵PEM / ルートCA PEM（任意）')
                        yield Input(value=self.args.tls_cert or '', placeholder='/srv/certs/fullchain.pem', id='tls-cert')
                        yield Input(value=self.args.tls_key or '', placeholder='/srv/certs/key.pem', id='tls-key')
                        yield Input(value=self.args.tls_ca or '', placeholder='/srv/certs/root-ca.pem（任意）', id='tls-ca')
                        yield Checkbox('既存の専用K3sへ導入する（既存データは保持）', value=self.args.adopt_existing, id='adopt')
                    yield Static('', id='form-error', classes='error', markup=False)
                    yield Button('設定を確認する →', id='review-button', variant='primary')
                with VerticalScroll(id='review'):
                    yield Label('この内容で準備します', classes='heading')
                    yield Static('', id='summary', classes='card', markup=False)
                    yield Static('はじめにOSの準備・sudo認証のため標準端末へ切り替えます。\nその後、この画面でモデルの取得と起動状況を確認できます。', classes='notice')
                    yield Static('初回はモデル取得とビルドに数十分かかることがあります。ドライバー反映で再起動した場合は、同じコマンドで再開できます。', classes='description')
                    with Horizontal(classes='actions'):
                        yield Button('← 設定に戻る', id='back-button')
                        yield Button('準備をはじめる', id='start-button', variant='primary')
                with VerticalScroll(id='installing'):
                    yield Label('実行状況とログ', classes='heading')
                    yield Static('この画面のままお待ちください。', id='current-stage', classes='card-title', markup=False)
                    yield ProgressBar(total=len(STAGES), show_eta=False, show_percentage=False, id='progress')
                    yield Static('進捗は作業段階の目安です。大きなモデルの取得中は、同じ段階が続きます。', classes='muted')
                    with Collapsible(title='詳しい実行ログ', collapsed=True, id='execution-details'):
                        yield RichLog(id='logs', wrap=True, markup=False, highlight=False, max_lines=1000)
                    yield Button('結果に戻る', id='return-result')
                with VerticalScroll(id='finished'):
                    yield Label('準備ができました', id='result-title', classes='heading')
                    yield Static('', id='result', classes='card', markup=False)
                    with Vertical(id='password-form', classes='card'):
                        yield Label('管理者の初回パスワード（設定済みなら不要）', classes='card-title')
                        yield Label('12〜128文字。入力内容は保存ファイルやログに残しません。')
                        yield Input(password=True, placeholder='初回パスワード', id='password')
                        yield Input(password=True, placeholder='もう一度入力', id='password-confirm')
                        yield Static('', id='password-error', classes='error', markup=False)
                        yield Button('パスワードを設定する', id='password-button', variant='primary')
                    with Horizontal(classes='actions'):
                        yield Button('設定に戻る', id='retry-button')
                        yield Button('ログを確認', id='view-logs')
                        yield Button('閉じる', id='close-button', variant='primary')
        yield Footer()

    def on_mount(self):
        self.query_one('#return-result', Button).display = False
        if self.saved.get('admin_created'):
            self.query_one('#username', Input).disabled = True
            self.query_one('#email', Input).disabled = True
        if self.saved and not self.args.migrate_url:
            for selector in ('#url', '#listen-ip', '#tls-mode'):
                self.query_one(selector).disabled = True
        self.update_connection_hint()
        self.query_one('#email', Input).focus()

    def on_resize(self, event):
        self.set_class(event.size.width < 90, 'compact')

    def update_connection_hint(self):
        mode = str(self.query_one('#tls-mode', Select).value)
        text = {'internal': '内部CAで暗号化', 'provided': '持ち込み証明書', 'acme': '公開ACME証明書', 'none': 'SSH localhost'}.get(mode, '')
        ip = self.query_one('#listen-ip', Input).value
        listener = '全IPv4で待受' if ip == '0.0.0.0' else f'待受 {ip}'
        self.query_one('#auto-details', Static).update(f'{listener} / {"HTTPS・443番" if mode != "none" else "ローカル接続"} / {text}')

    def on_input_changed(self, event: Input.Changed):
        if not self.is_mounted:
            return
        if event.input.id == 'url':
            self.query_one('#auto-url', Static).update(event.value or '接続先のURLを入力してください。')
        elif event.input.id == 'listen-ip':
            self.update_connection_hint()

    def on_select_changed(self, event: Select.Changed):
        if self.is_mounted and event.select.id == 'tls-mode':
            self.update_connection_hint()
        if event.select.id == 'lan-choice' and event.value is not Select.BLANK:
            self.query_one('#url', Input).value = str(event.value)
            self.query_one('#auto-url', Static).update(str(event.value))

    def page(self, name, step):
        self.query_one('#pages', ContentSwitcher).current = name
        self.query_one('#steps', Static).update('\n\n'.join(('● ' if index == step else '  ') + text for index, text in enumerate(('1  設定', '2  内容を確認', '3  導入状況', '4  使いはじめる'), 1)))
        self.query_one('#' + name).scroll_home(animate=False)

    def read_plan(self):
        args = copy.copy(self.args)
        for field in ('username', 'email', 'url', 'listen_ip', 'tls_cert', 'tls_key', 'tls_ca'):
            value = self.query_one('#' + field.replace('_', '-'), Input).value.strip()
            setattr(args, field, value or None)
        if not args.url:
            raise ValueError('接続先のIPを選択するか、詳細設定でHTTPS URLを入力してください。')
        args.tls_mode = str(self.query_one('#tls-mode', Select).value)
        args.adopt_existing = self.query_one('#adopt', Checkbox).value
        if args.url.startswith('http://'):
            args.listen_ip = args.tls_mode = None
        if not args.username or not args.email:
            raise ValueError('ユーザー名とメールアドレスを入力してください。')
        return validate_plan(args, self.saved)

    def on_button_pressed(self, event: Button.Pressed):
        button = event.button.id
        if button == 'review-button':
            try:
                self.plan = self.read_plan()
            except (ValueError, OSError) as error:
                self.query_one('#form-error', Static).update(str(error))
                return
            self.query_one('#form-error', Static).update('')
            mode = {'internal': '内部CA（各PCへCA証明書を登録）', 'provided': '大学などの持ち込み証明書', 'acme': '公開ACME'}.get(self.plan.tls_mode, 'SSH localhost')
            self.query_one('#summary', Static).update(f'アクセスURL  {self.plan.url}\n\n待受IP  {self.plan.listen_ip or "127.0.0.1"}\n証明書  {mode}\n\n管理者  {self.plan.username}\nメール  {self.plan.email}\n\nAIモデル  GPT-OSS 20B / EmbeddingGemma 2 / Whisper turbo')
            self.page('review', 2)
            self.query_one('#start-button', Button).focus()
        elif button in ('back-button', 'retry-button'):
            self.page('settings', 1)
        elif button == 'view-logs':
            self.query_one('#execution-details', Collapsible).collapsed = False
            self.page('installing', 3)
        elif button == 'return-result':
            self.page('finished', 4)
        elif button == 'start-button' and not self.running:
            self.start_installation()
        elif button in ('close-button',):
            self.action_safe_quit()
        elif button == 'password-button':
            password = self.query_one('#password', Input).value
            confirm = self.query_one('#password-confirm', Input).value
            if not 12 <= len(password) <= 128 or password != confirm:
                self.query_one('#password-error', Static).update('12〜128文字で、確認欄にも同じパスワードを入力してください。')
                return
            self.query_one('#password', Input).value = self.query_one('#password-confirm', Input).value = ''
            self.query_one('#password-button', Button).disabled = True
            self.running = True
            self.save_password(password)

    def start_installation(self):
        self.running = True
        self.status = 1
        if not self.preview:
            # sudo owns its standard terminal UI; never collect its credentials.
            with self.suspend():
                print('\nVideoQ: OSの準備・sudo認証を行います。完了後はセットアップ画面に戻ります。\n', flush=True)
                result = subprocess.run(['bash', str(SCRIPT), '--no-tui', *arguments(self.plan)], env={**os.environ, 'VIDEOQ_BOOTSTRAP_ONLY': '1'})
            if result.returncode or (Path(self.plan.directory).expanduser() / 'driver-boot-id').exists():
                self.show_result(False, 'OSの準備が中断されたか、再起動が必要です。同じ起動コマンドで再開してください。')
                return
        self.page('installing', 3)
        self.query_one('#return-result', Button).display = False
        self.query_one('#logs', RichLog).clear()
        self.query_one('#progress', ProgressBar).update(progress=0)
        self.install_worker()

    @work(thread=True, exclusive=True, exit_on_error=False)
    def install_worker(self):
        if self.preview:
            for index, stage in enumerate(STAGES, 1):
                self.call_from_thread(self.receive_line, f'{index}/{len(STAGES)} {stage}（プレビュー）')
            self.call_from_thread(self.show_result, True, '')
            return
        env = {**os.environ, 'VIDEOQ_NONINTERACTIVE': '1', 'PYTHONUNBUFFERED': '1'}
        env.pop('VIDEOQ_BOOTSTRAP_ONLY', None)
        stopped = threading.Event()
        def keep_sudo():
            # Keep the already-authorized ticket alive; never grant new privileges.
            while not stopped.wait(60):
                subprocess.run(['sudo', '-n', '-v'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        keeper = threading.Thread(target=keep_sudo, daemon=True)
        keeper.start()
        try:
            with subprocess.Popen(['bash', str(SCRIPT), '--no-tui', *arguments(self.plan)], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace", bufsize=1, env=env) as child:
                for line in child.stdout:
                    self.call_from_thread(self.receive_line, line.rstrip())
                status = child.wait()
            if status == 0:
                try:
                    installed = json.loads((Path(self.plan.directory).expanduser() / 'installation.json').read_text())
                    if not installed.get('complete') or installed.get('pending_url') or installed.get('url') != self.plan.url:
                        status = 1
                except (OSError, ValueError):
                    status = 1
            self.call_from_thread(self.show_result, status == 0, '' if status == 0 else '導入を完了できませんでした。詳しいログを確認し、同じ設定で再実行できます。')
        except OSError:
            self.call_from_thread(self.show_result, False, '起動コマンドを実行できませんでした。ソースの場所と実行権限を確認してください。')
        finally:
            stopped.set()

    def receive_line(self, text):
        text = ANSI.sub('', text)
        self.query_one('#logs', RichLog).write(text)
        match = re.match(rf'([1-{len(STAGES)}])/{len(STAGES)}\s+(.+)', text)
        if match:
            step = int(match[1])
            self.query_one('#current-stage', Static).update(f'{step} / {len(STAGES)}  {STAGES[step - 1]}')
            self.query_one('#progress', ProgressBar).update(progress=step - 1)

    def show_result(self, success, message):
        self.running = False
        self.status = 0 if success else 1
        self.page('finished', 4)
        self.query_one('#result-title', Label).update('準備ができました' if success else 'ここで一度、確認しましょう')
        self.query_one('#return-result', Button).display = True
        self.query_one('#current-stage', Static).update('導入が完了しました' if success else '導入が停止しました')
        self.query_one('#retry-button', Button).display = not success
        self.query_one('#password-form').display = success and self.needs_password and not self.preview
        if success:
            root = Path(self.plan.directory).expanduser()
            text = f'ブラウザで開くURL\n{self.plan.url}\n\n管理者ユーザー名  {self.plan.username}'
            if self.plan.tls_mode == 'internal':
                text += f'\n\nはじめに：各PCへCA証明書を信頼登録してください。\n{root / "tls/root-ca.crt"}\n配布するのはこの証明書だけです。秘密鍵は配布しません。'
            elif self.plan.tls_mode == 'provided':
                text += '\n\n持ち込み証明書は発行元で更新し、新しいPEMを指定して再実行してください。'
            if self.preview:
                text += '\n\nこれはプレビューです。実際の導入は行っていません。'
            self.query_one('#progress', ProgressBar).update(progress=len(STAGES))
        else:
            text = message + '\n\nデータと導入記録は保持しています。再実行で途中から再開できます。'
        self.query_one('#result', Static).update(text)
        self.query_one('#close-button', Button).focus()

    @work(thread=True, exclusive=True, exit_on_error=False)
    def save_password(self, password):
        try:
            instance = rtx4090.NativeInstaller(self.plan)
            try:
                instance.configure_trust()
                setup = json.loads((instance.directory / 'admin-setup.json').read_text())
                rtx4090.activate_admin(instance.url, setup['activation_url'], password, instance.http_client)
                instance.record(admin_password_set=True)
            finally:
                instance.lock.close()
            self.call_from_thread(self.password_done, True)
        except (OSError, ValueError, subprocess.CalledProcessError):
            self.call_from_thread(self.password_done, False)
        finally:
            del password

    def password_done(self, success):
        self.running = False
        self.query_one('#password-button', Button).disabled = False
        self.query_one('#password-error', Static).update('初回パスワードを設定しました。ブラウザでログインできます。' if success else '設定できませんでした。HTTPS接続と初回リンクの有効期限を確認してください。')
        if success:
            self.query_one('#password', Input).disabled = self.query_one('#password-confirm', Input).disabled = True
            self.query_one('#password-button', Button).disabled = True

    def action_safe_quit(self):
        if self.running:
            self.notify('作業中です。完了またはエラー表示までお待ちください。', severity='warning')
        else:
            self.exit(self.status)

    def action_help(self):
        self.notify('Tab / Shift+Tabで移動、Enterで決定。詳細設定は通常そのままで使えます。', timeout=10)


def main():
    parser = rtx4090.parser()
    parser.add_argument('--preview', action='store_true', help='Preview screens without installing anything')
    args = parser.parse_args()
    try:
        app = VideoQInstaller(args, preview=args.preview)
        return app.run() or 0
    except (OSError, ValueError) as error:
        print('画面を開始できませんでした: ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
