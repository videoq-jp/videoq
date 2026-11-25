"""Actual candidate Dockerfile controls on the owned warm disposable builder.

No mutation survives this process; probe tags never replace measured/scanned tags.
Patch integrity fails closed, valid recipe changes really recompile, and application
or VITE input changes must reuse the expensive compiler but change final image IDs.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess

spec = importlib.util.spec_from_file_location('cache', Path(__file__).with_name('check-openssl-cache.py'))
cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--builder', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    receipt = []

    def probe(name, component, extra=(), failure=False, reuse=True):
        tag = f'videoq-cache-probe:{name}'
        log = args.output / (name + '.log')
        baseline = subprocess.check_output(['docker', 'image', 'inspect', '--format', '{{.Id}}', f'videoq-{component}:onprem-ci'], text=True).strip()
        try:
            with log.open('w') as stream:
                result = subprocess.run(['docker', 'buildx', 'build', '--builder', args.builder,
                    '--platform', 'linux/amd64', '--load', '--progress=plain', '-t', tag,
                    '-f', f'apps/{component}/Dockerfile', *extra, '.'], stdout=stream, stderr=subprocess.STDOUT, timeout=2400)
            if failure:
                if result.returncode == 0 or 'checksum' not in log.read_text().lower():
                    raise ValueError('Changed patch must fail actual checksum validation')
                receipt.append({'control': name, 'expectedChecksumRejection': True})
                return
            if result.returncode:
                raise ValueError(f'Actual probe failed: {name}')
            compiled = cache.compiled(log)
            if compiled == reuse:
                raise ValueError(f'Unexpected compiler reuse for {name}')
            image = subprocess.check_output(['docker','image','inspect','--format','{{.Id}}',tag],text=True).strip()
            if image == baseline:
                raise ValueError(f'Changed real input did not change final image: {name}')
            receipt.append({'control': name, 'compilerReused': not compiled, 'originalImageId': baseline, 'changedImageId': image})
        finally:
            subprocess.run(['docker','image','rm',tag],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=False)

    def mutate(path, suffix, operation):
        original = path.read_bytes()
        try:
            path.write_bytes(original + suffix)
            operation()
        finally:
            path.write_bytes(original)

    try:
        mutate(Path('apps/api/src/runtime/node.ts'), b'\nconsole.info("videoq isolated compiler cache control");\n', lambda: probe('api-source', 'api'))
        probe('vite-input', 'web', ['--build-arg', 'VITE_API_URL=/api/isolated-cache-control'])
        patches = sorted(Path('apps/security/openssl').glob('*.patch'))
        if not patches:
            raise ValueError('Missing real security patch input')
        mutate(patches[0], b'\n# isolated integrity negative control\n', lambda: probe('patch-integrity', 'api', failure=True))
        mutate(Path('apps/security/openssl/APKBUILD'), b'\n# isolated recipe invalidation control\n', lambda: probe('recipe-rebuild', 'api', reuse=False))
        # A trusted refresh changes the compiler parent RUN, not an app-only key.
        probe('security-parent-refresh', 'api', ['--build-arg', 'OPENSSL_SECURITY_REFRESH=isolated-control-2026-11-25'], reuse=False)
        dockerfile = Path('apps/api/Dockerfile')
        original = dockerfile.read_bytes()
        try:
            changed = original.replace(b'MAKEFLAGS=-j4 abuild', b'MAKEFLAGS=-j3 abuild')
            if changed == original:
                raise ValueError('Missing real compiler flag input')
            dockerfile.write_bytes(changed)
            probe('compiler-flags', 'api', reuse=False)
        finally:
            dockerfile.write_bytes(original)
    finally:
        (args.output / 'result.json').write_text(json.dumps(receipt, indent=2) + '\n')
    if len(receipt) != 6:
        raise ValueError('Incomplete real invalidation controls')


if __name__ == '__main__':
    main()
