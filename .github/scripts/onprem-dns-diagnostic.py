"""Log DNS observations without changing resolvers or accepting stale packages."""
import concurrent.futures
import json
import os
from pathlib import Path
import pwd
import socket
import sys

HOSTS = ('archive.ubuntu.com', 'security.ubuntu.com', 'ppa.launchpadcontent.net',
         'developer.download.nvidia.com', 'pypi.org')


def lookup(host):
    try:
        addresses = sorted({item[4][0] for item in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)})
        return {'host': host, 'addresses': addresses[:3]}
    except OSError as error:
        return {'host': host, 'error': str(error)}


def probe():
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(HOSTS)) as pool:
        results = list(pool.map(lookup, HOSTS))
    print(json.dumps({'uid': os.geteuid(), 'user': pwd.getpwuid(os.geteuid()).pw_name,
                      'resolvConf': Path('/etc/resolv.conf').read_text()[:4096],
                      'results': results}), flush=True)
    return all('error' not in row and row.get('addresses') for row in results)


if __name__ == '__main__':
    success = probe()
    required = '--require-success' in sys.argv[1:]
    if os.geteuid() == 0:
        try:
            account = pwd.getpwnam('_apt')
        except KeyError:
            account = None
        if account:
            pid = os.fork()
            if pid == 0:
                os.setgroups([])
                os.setgid(account.pw_gid)
                os.setuid(account.pw_uid)
                okay = probe()
                os._exit(0 if okay or not required else 1)
            _, status = os.waitpid(pid, 0)
            if status:
                raise SystemExit(os.waitstatus_to_exitcode(status))

    if required and not success:
        raise SystemExit(1)
