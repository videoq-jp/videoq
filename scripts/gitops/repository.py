"""Credential-free Git transport URLs, including internal Forgejo and GitLab."""
import re
from urllib.parse import urlsplit


def validate_repository(value):
    if not isinstance(value, str) or any(c.isspace() or ord(c) < 32 for c in value):
        raise ValueError('Invalid Git repository URL')
    if re.fullmatch(r'git@[A-Za-z0-9][A-Za-z0-9.-]*:[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+[.]git', value):
        parts = value.split(':', 1)[1].split('/')
    else:
        p = urlsplit(value)
        if (p.scheme not in ('https', 'ssh') or not p.hostname or p.password or p.query or p.fragment
                or (p.scheme == 'https' and p.username) or (p.scheme == 'ssh' and p.username != 'git')):
            raise ValueError('Use HTTPS without credentials or SSH as git')
        p.port
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]*', p.hostname):
            raise ValueError('Invalid Git hostname')
        parts = p.path.lstrip('/').split('/')
        if len(parts) < 2 or not p.path.endswith('.git') or not all(re.fullmatch(r'[A-Za-z0-9_.-]+', x) for x in parts):
            raise ValueError('Invalid Git repository path')
    if any(x in ('.', '..') or x.startswith('-') for x in parts):
        raise ValueError('Invalid Git repository path')
    return value
