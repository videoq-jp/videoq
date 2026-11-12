"""HTTPS origins, listeners and private PEM validation shared by supported deployments."""
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


def require_certificate_hostname(cert, host):
    try:
        ipaddress.ip_address(host)
        option, label = '-checkip', 'IP'
    except ValueError:
        option, label = '-checkhost', 'Hostname'
    result = subprocess.run(['openssl', 'x509', '-in', str(cert), '-noout', option, host],
                            capture_output=True, text=True)
    # OpenSSL 3.0 returns zero even for "does NOT match certificate".
    # Require an explicit positive identity result as well as successful exit.
    if result.returncode != 0 or result.stdout.strip() != f'{label} {host} does match certificate':
        raise ValueError('証明書のSANがブラウザ用URLと一致しません')


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
            if 'Subject Alternative Name' not in san.stdout or (check == '-checkhost' and 'DNS:' not in san.stdout):
                raise ValueError('証明書にURLに対応するSANが必要です')
            subprocess.run(['openssl', 'x509', '-in', str(cert), '-noout', '-checkend', '0'],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            require_certificate_hostname(cert, host)
            if 'ca.crt' in contents:
                ssl.create_default_context(cadata=contents['ca.crt'].decode())
        except (ssl.SSLError, UnicodeError, subprocess.CalledProcessError):
            raise ValueError('証明書の期限・URLのSAN・秘密鍵の一致・CA PEMを確認してください') from None
    for name, content in contents.items():
        private_pem(directory / name, content)


def verified_opener(ca=None, *, connect_ip=None):
    context = ssl.create_default_context()
    if ca:
        context.load_verify_locations(cafile=str(ca))
    if connect_ip is None:
        return build_opener(ProxyHandler({}), HTTPSHandler(context=context))
    # Private canary checks connect directly to a gateway Pod while public
    # admission is closed. URL/Host/SNI and certificate hostname checks remain
    # those of the real browser origin; only the TCP destination changes.
    import ipaddress
    import socket
    from http.client import HTTPSConnection
    address = str(ipaddress.ip_address(connect_ip))

    class CanaryConnection(HTTPSConnection):
        def __init__(self, host, **kwargs):
            super().__init__(host, **kwargs)
            self._create_connection = lambda destination, timeout, source_address=None: socket.create_connection(
                (address, destination[1]), timeout, source_address)

    class CanaryHandler(HTTPSHandler):
        def https_open(self, request):
            return self.do_open(CanaryConnection, request, context=context)

    return build_opener(ProxyHandler({}), CanaryHandler(context=context))
