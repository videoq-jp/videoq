#!/usr/bin/env python3
"""Prove the FIPS assessment against the immutable image before applying its VEX."""
import argparse
import hashlib
import json
import pathlib
import re
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[2]
FILES = ['runtime_security.py', 'lambda_handler.py']
PROBE = r'''
import sys,json,hashlib,pathlib,subprocess,platform,_hashlib
expected=json.loads(sys.argv[1])
def require(condition,message):
 if not condition:raise RuntimeError(message)
require(platform.machine() in ('aarch64','arm64'), 'Expected native ARM64 runtime')
for name,digest in expected.items():
 require(hashlib.sha256(pathlib.Path('/var/task/worker_python',name).read_bytes()).hexdigest()==digest, 'Runtime source differs from reviewed guard')
from worker_python import runtime_security
runtime_security.verify_hashlib_runtime()
from worker_python import lambda_handler
for name,module in [('runtime_security.py',runtime_security),('lambda_handler.py',lambda_handler)]:
 require(pathlib.Path(module.__file__).resolve()==pathlib.Path('/var/task/worker_python',name).resolve(), 'Loaded module differs from reviewed source path')
mode=_hashlib.get_fips_mode()
checks=[]
if sys.version_info[:3]==(3,14,10):
 require(mode==0, 'Affected FIPS configuration')
 _hashlib.get_fips_mode=lambda:1
 for action in [runtime_security.verify_hashlib_runtime,lambda:lambda_handler.handler({'Records':[]},None)]:
  try:action()
  except RuntimeError as error:require('CVE-2026-119170' in str(error), 'Missing FIPS refusal reason')
  else:raise AssertionError('Affected FIPS configuration was accepted')
 child=subprocess.run([sys.executable,'-c','import _hashlib;_hashlib.get_fips_mode=lambda:1;import worker_python.lambda_handler'],capture_output=True,text=True,timeout=30)
 require(child.returncode!=0 and 'CVE-2026-119170' in child.stderr, 'Import did not reject FIPS')
 checks=['guard','import','invocation']
print(json.dumps({'python':list(sys.version_info[:3]),'fipsMode':mode,'fipsRefusalChecks':checks,'sources':expected}))
'''


def validate(receipt, expected):
    if receipt.get('sources') != expected:
        raise ValueError('Unverified runtime source')
    version = receipt.get('python')
    if not isinstance(version, list) or len(version) != 3 or any(type(n) is not int for n in version):
        raise ValueError('Missing Python runtime version')
    if version == [3, 14, 10] and (receipt.get('fipsMode') != 0 or receipt.get('fipsRefusalChecks') != ['guard', 'import', 'invocation']):
        raise ValueError('Incomplete FIPS refusal proof')
    return receipt


def verify(image):
    if not re.fullmatch(r'[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}', image):
        raise ValueError('An immutable registry image is required')
    expected = {name: hashlib.sha256((ROOT / 'apps/worker/worker_python' / name).read_bytes()).hexdigest() for name in FILES}
    subprocess.run(['docker', 'pull', '--platform', 'linux/arm64', image], check=True, stdout=subprocess.DEVNULL, timeout=600)
    identity = json.loads(subprocess.run(['docker', 'image', 'inspect', image], check=True, capture_output=True, text=True, timeout=30).stdout)[0]
    if identity.get('Architecture') != 'arm64' or identity.get('Os') != 'linux' or image not in identity.get('RepoDigests', []):
        raise ValueError('Production image identity mismatch')
    result = subprocess.run(['docker', 'run', '--rm', '--platform', 'linux/arm64', '--network', 'none', '--read-only', '--user', '10001:10001', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--entrypoint', '/var/lang/bin/python3.14', image, '-c', PROBE, json.dumps(expected)], check=True, capture_output=True, text=True, timeout=90)
    receipt = validate(json.loads(result.stdout), expected)
    return {'image': image, 'configDigest': identity['Id'], 'runtime': receipt}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    args = parser.parse_args()
    args.output.write_text(json.dumps(verify(args.image), indent=2) + '\n')
