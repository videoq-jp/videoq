"""Interactive native-host listener and TLS setup, with resumable private PEM copies."""
import ipaddress
import os
from pathlib import Path
import re
import ssl
import subprocess
import tempfile
from urllib.parse import urlsplit
from urllib.request import HTTPSHandler, ProxyHandler, build_opener

from common import origin


def https_origin(value):
    result = origin(value)
    parsed = urlsplit(result)
    if parsed.scheme != 'https' or parsed.port not in (None, 443):
        raise ValueError('HTTPS URLは https://ホスト名 または https://IP（443番）で指定してください')
    host = parsed.hostname
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        if len(host) > 253 or not all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label) for label in host.split('.')):
            raise ValueError('URLのホスト名が不正です')
        if re.fullmatch(r'[0-9.]+', host):
            raise ValueError('URLのIPアドレスが不正です')
    else:
        if address.version != 4 or address.is_unspecified or address.is_multicast:
            raise ValueError('アクセス先には到達可能なIPv4を指定してください')
    return result


def listen_ip(value):
    try:
        address = ipaddress.IPv4Address(value)
    except ipaddress.AddressValueError:
        raise ValueError('待受IPはこのマシンのIPv4、または0.0.0.0を指定してください') from None
    if address.is_multicast or str(address) == '255.255.255.255':
        raise ValueError('待受IPが不正です')
    return str(address)


def network_details(args, state, ask=None):
    """Prompt only for missing first-install inputs. Never change existing NIC settings."""
    ask = ask or input
    recorded = state.get('network', {})
    url = args.url or state.get('pending_url') or state.get('url')
    interactive = not url
    ip = getattr(args, 'listen_ip', None) or recorded.get('listen_ip')
    if interactive:
        print('研究室内HTTPSの接続先を設定します。IPの固定・DHCP予約とDNS登録はネットワーク管理者側で行ってください。')
        ip = ip or ask('このマシンの待受IPv4 [0.0.0.0 = 全IPv4]: ').strip() or '0.0.0.0'
        ip = listen_ip(ip)
        default = 'https://' + ip if ip != '0.0.0.0' else ''
        url = ask('ブラウザで使うHTTPS URL' + (f' [{default}]' if default else '（例 https://videoq.lab.example.ac.jp）') + ': ').strip() or default
    if url.startswith('http://'):
        if any(getattr(args, k, None) for k in ('listen_ip', 'tls_mode', 'tls_cert', 'tls_key', 'tls_ca')):
            raise ValueError('HTTP localhostモードではIP・証明書オプションを指定できません')
        return url, {'listen_ip': '127.0.0.1', 'tls_mode': 'none'}
    url = https_origin(url)
    ip = listen_ip(ip or '0.0.0.0')
    mode = getattr(args, 'tls_mode', None) or recorded.get('tls_mode')
    if mode == 'none':
        mode = None  # Explicit HTTP -> HTTPS URL migration.
    if not mode:
        mode = (ask('証明書方式 [1: 内部CA（既定） / 2: 持ち込み証明書 / 3: 公開ACME]: ').strip() or '1') if interactive else 'acme'
        mode = {'1': 'internal', '2': 'provided', '3': 'acme'}.get(mode, mode)
    if mode not in ('internal', 'provided', 'acme'):
        raise ValueError('証明書方式は internal / provided / acme で指定してください')
    if mode == 'acme':
        from k3s import public_origin
        public_origin(url)
    details = {'listen_ip': ip, 'tls_mode': mode}
    for flag, prompt in (('tls_cert', '証明書PEM（サーバー証明書＋中間証明書）のパス: '), ('tls_key', '秘密鍵PEMのパス: '), ('tls_ca', '検証用ルートCA PEMのパス（OSで信頼済みなら空欄）: ')):
        value = getattr(args, flag, None)
        if mode == 'provided':
            if interactive and not value:
                value = ask(prompt).strip()
            if value:
                details[flag] = str(Path(value).expanduser().resolve())
        elif value:
            raise ValueError('証明書ファイルは provided 方式でのみ指定できます')
    if recorded and any(recorded.get(key) != details[key] for key in ('listen_ip', 'tls_mode')) and state.get('url') == url:
        raise ValueError('再実行では待受IP・証明書方式を変更できません。保存済み設定を使用してください')
    return url, details


def private_pem(path, content):
    """Atomic replacement: a certificate's original source may be outside state storage."""
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(content)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def prepare_certificate(directory, details, url):
    if details['tls_mode'] != 'provided':
        return
    directory = Path(directory) / 'tls'
    contents = {}
    for flag, name in (('tls_cert', 'tls.crt'), ('tls_key', 'tls.key'), ('tls_ca', 'ca.crt')):
        source = Path(details[flag]) if flag in details else directory / name
        if source.is_file():
            contents[name] = source.read_bytes()
        elif flag != 'tls_ca' or flag in details:
            raise ValueError('読み込める証明書・秘密鍵PEMを指定してください: ' + flag)
    # Validate before overwriting any recorded certificate or private key.
    with tempfile.TemporaryDirectory() as temporary:
        cert, key = Path(temporary) / 'cert.pem', Path(temporary) / 'key.pem'
        private_pem(cert, contents['tls.crt']); private_pem(key, contents['tls.key'])
        try:
            ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER).load_cert_chain(cert, key, password=lambda: '')
            host = urlsplit(url).hostname
            try:
                ipaddress.ip_address(host); check = '-checkip'
            except ValueError:
                check = '-checkhost'
            san = subprocess.run(['openssl', 'x509', '-in', str(cert), '-noout', '-ext', 'subjectAltName'], check=True, capture_output=True, text=True)
            if 'Subject Alternative Name' not in san.stdout:
                raise ValueError('証明書にURLに対応するSANが必要です')
            for arguments in (['-checkend', '0'], [check, host]):
                subprocess.run(['openssl', 'x509', '-in', str(cert), '-noout', *arguments], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if 'ca.crt' in contents:
                ssl.create_default_context(cadata=contents['ca.crt'].decode())
        except (ssl.SSLError, UnicodeError, subprocess.CalledProcessError):
            raise ValueError('証明書の期限・URLのSAN・秘密鍵の一致・CA PEMを確認してください') from None
    for name, content in contents.items():
        private_pem(directory / name, content)


def verified_opener(ca=None):
    context = ssl.create_default_context()
    if ca:
        context.load_verify_locations(cafile=str(ca))
    return build_opener(ProxyHandler({}), HTTPSHandler(context=context))
