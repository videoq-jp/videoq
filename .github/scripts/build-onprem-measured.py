"""Bounded image builds with comparable timing and runner resource evidence.

No imported cache: each job uses only its disposable runner's BuildKit cache.
All existing image tags are loaded for downstream smoke tests and scanners.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
import tempfile
import time
import uuid

COMPONENTS = {
    'api': ('apps/api/Dockerfile', '.'),
    'worker': ('apps/worker/Dockerfile.onprem', 'apps/worker'),
    'web': ('apps/web/Dockerfile', '.'),
}


def verify_cache(output, builder=None):
    """Check actual BuildKit reuse and COPY invalidation without external images."""
    tag = f'videoq-cache-control:{uuid.uuid4().hex}'
    identities = []
    try:
        with tempfile.TemporaryDirectory(prefix='videoq-cache-control-') as directory:
            context = Path(directory)
            (context / 'Dockerfile').write_text('FROM scratch\nCOPY input /input\n')
            for index, content in enumerate(['first', 'first', 'changed']):
                (context / 'input').write_text(content)
                command = ['docker', 'buildx', 'build', '--load', '--provenance=false', '--platform', 'linux/amd64', '-t', tag]
                if builder:
                    command += ['--builder', builder]
                with (output / f'cache-control-{index}.log').open('w') as log:
                    subprocess.run(command + [directory], check=True, stdout=log, stderr=subprocess.STDOUT, timeout=120)
                identities.append(subprocess.check_output(['docker', 'image', 'inspect', '--format', '{{.Id}}', tag], text=True).strip())
        if identities[0] != identities[1] or identities[1] == identities[2]:
            raise RuntimeError('BuildKit did not preserve same-input identity and invalidate changed input')
        return {'sameInputReused': True, 'changedInputInvalidated': True, 'imageIds': identities}
    finally:
        subprocess.run(['docker', 'image', 'rm', tag], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)



def inspect_builder_limits(container, cpus, memory_bytes):
    """Fail before timing if the paired experiment's effective caps differ."""
    info = json.loads(subprocess.check_output(
        ['docker', 'container', 'inspect', container], text=True))[0]
    config = info['HostConfig']
    period, quota = config.get('CpuPeriod', 0), config.get('CpuQuota', 0)
    if not info.get('State', {}).get('Running') or period <= 0 or quota != period * cpus:
        raise ValueError('BuildKit CPU limit is missing or differs from the protocol')
    if config.get('Memory') != memory_bytes or config.get('MemorySwap') != memory_bytes:
        raise ValueError('BuildKit memory/swap limits differ from the protocol')
    return {'container': container, 'cpus': cpus, 'memoryBytes': memory_bytes,
            'cpuPeriod': period, 'cpuQuota': quota, 'memorySwapBytes': config['MemorySwap'],
            'cpusetCpus': config.get('CpusetCpus', ''), 'verifiedBeforeBuild': True}


def resources():
    memory = {}
    if Path('/proc/meminfo').exists():
        memory = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
    return {'cpus': os.cpu_count(), 'memoryTotal': memory.get('MemTotal', '').strip(),
            'memoryAvailable': memory.get('MemAvailable', '').strip(),
            'loadAverage': list(os.getloadavg()),
            'diskFreeBytes': shutil.disk_usage('.').free}


def build(component, output, builder=None):
    dockerfile, context = COMPONENTS[component]
    command = ['docker', 'buildx', 'build', '--load', '--progress=plain', '--platform', 'linux/amd64']
    if builder:
        command += ['--builder', builder]
    command += ['-t', f'videoq-{component}:onprem-ci', '-f', dockerfile, context]
    started = time.monotonic()
    with (output / f'{component}.log').open('w') as log:
        result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=False)
    identity = None
    if result.returncode == 0:
        identity = subprocess.check_output(['docker', 'image', 'inspect', '--format', '{{.Id}}',
                    f'videoq-{component}:onprem-ci'], text=True).strip()
    return {'component': component, 'seconds': round(time.monotonic() - started, 3),
            'exitCode': result.returncode, 'imageId': identity}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--parallelism', type=int, choices=[1, 2], default=1)
    parser.add_argument('--output', type=Path, default=Path('artifacts/onprem-build'))
    parser.add_argument('--builder')
    parser.add_argument('--builder-container')
    parser.add_argument('--required-builder-cpus', type=int)
    parser.add_argument('--required-builder-memory', type=int)
    parser.add_argument('--repetitions', type=int, choices=[1, 2, 3], default=1)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    report = {'source': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
        'parallelism': args.parallelism, 'before': resources(),
        'cachePolicy': 'runner-local only; no external cache imported or published',
        'platform': 'linux/amd64', 'startedAt': time.time(), 'components': []}
    controls = [args.builder_container, args.required_builder_cpus, args.required_builder_memory]
    if any(value is not None for value in controls):
        if not all(value is not None for value in controls) or not args.builder:
            parser.error('Paired resource controls require builder, container, CPU and memory limits')
        if args.required_builder_cpus <= 0 or args.required_builder_memory <= 0:
            parser.error('Builder resource limits must be positive')
        report['buildkitLimits'] = inspect_builder_limits(
            args.builder_container, args.required_builder_cpus, args.required_builder_memory)
        report['runnerImage'] = {'os': os.environ.get('ImageOS'), 'version': os.environ.get('ImageVersion')}
        if Path('/proc/cpuinfo').exists():
            report['cpuModelNames'] = sorted(set(line.split(':', 1)[1].strip()
                for line in Path('/proc/cpuinfo').read_text().splitlines()
                if line.startswith('model name') and ':' in line))
    report['cacheControl'] = verify_cache(args.output, args.builder)
    started = time.monotonic()
    stop = threading.Event()
    samples = []

    def sample():
        while not stop.wait(2):
            samples.append(resources())

    sampler = threading.Thread(target=sample, daemon=True)
    sampler.start()
    report['runs'] = []
    try:
        for index in range(args.repetitions):
            output = args.output / f'run-{index + 1}'
            output.mkdir(exist_ok=True)
            run_started = time.monotonic()
            with ThreadPoolExecutor(max_workers=args.parallelism) as pool:
                components = list(pool.map(lambda component: build(component, output, args.builder), COMPONENTS))
            report['runs'].append({'index': index + 1, 'seconds': round(time.monotonic() - run_started, 3), 'components': components})
            report['components'].extend(components)
            if any(row['exitCode'] != 0 for row in components):
                break
    finally:
        stop.set()
        sampler.join()
    report['resourceSamples'] = samples
    report.update(seconds=round(time.monotonic() - started, 3), after=resources())
    report['failedBuilds'] = sum(row['exitCode'] != 0 for row in report['components'])
    (args.output / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
    if report['failedBuilds']:
        raise SystemExit('Image build failed; inspect retained component logs')


if __name__ == '__main__':
    main()
