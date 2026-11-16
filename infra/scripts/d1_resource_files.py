"""Private D1 SQL download/upload using provider-supplied R2 signed URLs.

No Cloudflare bearer token is accepted or forwarded. No redirects, overwrites
or automatic retries. An interrupted download remains a private .partial file
for explicit recovery; it is never treated as a completed SQL artifact.
"""
import hashlib
import os
from pathlib import Path
import re
import stat
import urllib.parse
import urllib.request
from d1_resource_fence_transport import NoRedirect

LIMIT = 1024 * 1024 * 1024


def signed_url(url):
    if not isinstance(url, str) or len(url) > 16384 or any(ord(c) < 33 for c in url):
        raise ValueError('RESOURCE_FILE_SIGNED_URL_REQUIRED')
    value = urllib.parse.urlsplit(url)
    if (value.scheme != 'https' or value.username or value.password or value.fragment
            or value.port not in (None, 443) or not value.hostname
            or not re.fullmatch(r'[a-z0-9.-]+\.r2\.cloudflarestorage\.com', value.hostname)
            or not value.query):
        raise ValueError('RESOURCE_FILE_SIGNED_URL_REQUIRED')
    return url


class PrivateSqlFiles:
    def __init__(self, directory, opener=None):
        root = Path(directory)
        if not root.is_absolute():
            raise ValueError('RESOURCE_FILE_PRIVATE_DIRECTORY_REQUIRED')
        info = root.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700 or info.st_uid != os.getuid():
            raise ValueError('RESOURCE_FILE_PRIVATE_DIRECTORY_REQUIRED')
        self.root, self.identity = root.resolve(), (info.st_dev, info.st_ino)
        self.opener = opener or urllib.request.build_opener(NoRedirect())

    def checked(self):
        info = self.root.lstat()
        if (not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700
                or info.st_uid != os.getuid() or (info.st_dev, info.st_ino) != self.identity):
            raise ValueError('RESOURCE_FILE_DIRECTORY_CHANGED')

    def sync_directory(self):
        fd = os.open(self.root, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    @staticmethod
    def hashes(handle):
        sha, md5, size = hashlib.sha256(), hashlib.md5(usedforsecurity=False), 0
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            size += len(chunk)
            if size > LIMIT:
                raise ValueError('RESOURCE_FILE_SIZE_LIMIT')
            sha.update(chunk)
            md5.update(chunk)
        return {'sha256': sha.hexdigest(), 'md5': md5.hexdigest(), 'bytes': size}

    def download(self, url, assert_owned):
        self.checked()
        request = urllib.request.Request(signed_url(url), method='GET')
        assert_owned()
        final, partial = self.root / 'source.sql', self.root / 'source.sql.partial'
        if final.exists() or final.is_symlink():
            raise ValueError('RESOURCE_FILE_ALREADY_EXISTS')
        fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, 'wb') as handle:
                try:
                    with self.opener.open(request, timeout=30) as response:
                        if response.status != 200:
                            raise ValueError('DOWNLOAD_FAILED')
                        length = response.headers.get('Content-Length')
                        if length is not None and (not length.isascii() or not length.isdigit() or not 0 < int(length) <= LIMIT):
                            raise ValueError('DOWNLOAD_LENGTH_INVALID')
                        size = 0
                        while chunk := response.read(1024 * 1024):
                            assert_owned()
                            size += len(chunk)
                            if size > LIMIT:
                                raise ValueError('DOWNLOAD_LIMIT')
                            handle.write(chunk)
                        if length is not None and size != int(length):
                            raise ValueError('DOWNLOAD_TRUNCATED')
                    handle.flush()
                    os.fsync(handle.fileno())
                except Exception:
                    raise ValueError('RESOURCE_FILE_DOWNLOAD_UNCERTAIN') from None
            self.checked()
            assert_owned()
            if partial.stat().st_size == 0:
                raise ValueError('RESOURCE_FILE_EMPTY')
            # link() is exclusive: unlike rename(), it cannot overwrite final.
            os.link(partial, final, follow_symlinks=False)
            partial.unlink()
            self.sync_directory()
            return self.inspect()
        except Exception:
            # Keep partial for explicit recovery; never silently overwrite it.
            raise

    def open_sql(self):
        self.checked()
        fd = os.open(self.root / 'source.sql', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        handle = os.fdopen(fd, 'rb')
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600
                or info.st_uid != os.getuid() or not 0 < info.st_size <= LIMIT):
            handle.close()
            raise ValueError('RESOURCE_FILE_UNSAFE')
        return handle, info

    def inspect(self):
        handle, before = self.open_sql()
        with handle:
            proof = self.hashes(handle)
            after = os.fstat(handle.fileno())
        self.checked()
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns) or proof['bytes'] != before.st_size:
            raise ValueError('RESOURCE_FILE_CHANGED')
        return proof

    def upload(self, url, proof, assert_owned):
        url = signed_url(url)
        if self.inspect() != proof:
            raise ValueError('RESOURCE_FILE_PROOF_CHANGED')
        assert_owned()
        handle, before = self.open_sql()
        with handle:
            request = urllib.request.Request(url, method='PUT', data=handle,
                                             headers={'Content-Length': str(before.st_size)})
            try:
                with self.opener.open(request, timeout=30) as response:
                    if response.status != 200 or response.headers.get('ETag', '').strip('"') != proof['md5']:
                        raise ValueError('UPLOAD_NOT_VERIFIED')
            except Exception:
                raise ValueError('RESOURCE_FILE_UPLOAD_UNCERTAIN') from None
        assert_owned()
        if self.inspect() != proof:
            raise ValueError('RESOURCE_FILE_PROOF_CHANGED')
        return {'uploaded': True, **proof}
