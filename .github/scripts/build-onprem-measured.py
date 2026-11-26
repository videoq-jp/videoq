"""Bounded image builds with comparable timing and runner resource evidence.

No imported cache: each job uses only its disposable runner's BuildKit cache.
All existing image tags are loaded for downstream smoke tests and scanners.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
import re
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



CONTROLLED_BUILDKIT_IMAGE = 'moby/buildkit@sha256:7583a0667093d941826bcd1d2878d6a360dfd08a82c93e6d6a6f6cce78801e12'


def cpu_set(value):
    result = set()
    for part in value.strip().split(','):
        if not part:
            continue
        if not re.fullmatch(r'\d+(?:-\d+)?', part):
            raise ValueError('Invalid effective CPU affinity')
        bounds = [int(item) for item in part.split('-')]
        first, last = bounds[0], bounds[-1]
        if last < first or last > 65535:
            raise ValueError('Invalid effective CPU range')
        result.update(range(first, last + 1))
    return result


def host_cgroup_limits(membership, cgroup_root=Path('/sys/fs/cgroup'), require_leaf=False):
    entries = [line[3:] for line in membership.read_text().splitlines() if line.startswith('0::')]
    if len(entries) != 1:
        raise ValueError('Controlled protocol requires cgroup v2 membership')
    root = cgroup_root.resolve()
    current = (root / entries[0].lstrip('/')).resolve()
    if not current.is_relative_to(root) or not current.is_dir():
        raise ValueError('Unresolved host cgroup membership')
    if require_leaf and not all((current / name).is_file() for name in ['cpu.max', 'memory.max']):
        raise ValueError('Actual builder cgroup controllers are not inspectable')
    quotas, memories, parents = [], [], []
    leaf = current
    while True:
        # The actual host root cgroup has no limit files; its absence is unlimited.
        # Child controllers can also be disabled while a parent remains limited.
        if (current / 'cpu.max').is_file():
            quota, period = (current / 'cpu.max').read_text().split()
            if int(period) <= 0:
                raise ValueError('Invalid inherited CPU quota period')
            if quota != 'max':
                quotas.append(int(quota) / int(period))
        if (current / 'memory.max').is_file():
            memory = (current / 'memory.max').read_text().strip()
            if memory != 'max':
                memories.append(int(memory))
        if current != leaf:
            parents.append({'path': '/' + str(current.relative_to(root)) if current != root else '/',
                'cpuMax': (current / 'cpu.max').read_text().strip() if (current / 'cpu.max').is_file() else None,
                'memoryMax': (current / 'memory.max').read_text().strip() if (current / 'memory.max').is_file() else None})
        if current == root:
            break
        current = current.parent
    return {'cpuQuotaCpus': min(quotas) if quotas else None,
            'memoryMaxBytes': min(memories) if memories else None,
            'membership': entries[0], 'parentLimits': parents}


def host_cpu_envelope(cgroup_root=Path('/sys/fs/cgroup'), membership=Path('/proc/self/cgroup')):
    if not hasattr(os, 'sched_getaffinity'):
        raise ValueError('Controlled protocol requires Linux effective affinity')
    return os.sched_getaffinity(0), host_cgroup_limits(membership, cgroup_root)['cpuQuotaCpus']


def builder_cgroup_envelope(pid, proc_root=Path('/proc'), cgroup_root=Path('/sys/fs/cgroup')):
    if type(pid) is not int or pid <= 0:
        raise ValueError('Missing actual BuildKit host PID')
    return host_cgroup_limits(proc_root / str(pid) / 'cgroup', cgroup_root, require_leaf=True)


def inspect_builder_limits(builder, cpus, memory_bytes):
    """Bind the inspected container to the selected single local BuildKit node."""
    rows = subprocess.check_output(['docker', 'buildx', 'ls', '--format=json'], text=True)
    builders = [json.loads(line) for line in rows.splitlines() if line.strip()]
    selected = [item for item in builders if item.get('Name') == builder]
    if len(selected) != 1 or selected[0].get('Driver') != 'docker-container' or selected[0].get('Err'):
        raise ValueError('Require the selected docker-container builder')
    nodes = selected[0].get('Nodes', [])
    if len(nodes) != 1 or nodes[0].get('Status') != 'running' or nodes[0].get('Err'):
        raise ValueError('Require exactly one running BuildKit node')
    node = nodes[0]
    context = json.loads(subprocess.check_output(['docker', 'context', 'inspect'], text=True))[0]
    endpoint = context['Endpoints']['docker']['Host']
    if not endpoint.startswith('unix://') or node.get('Endpoint') not in [endpoint, context['Name']]:
        raise ValueError('BuildKit node is not bound to this local Docker daemon')
    if os.environ.get('DOCKER_HOST', endpoint) != endpoint:
        raise ValueError('Docker host override differs from the inspected endpoint')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', node.get('Name', '')):
        raise ValueError('Invalid BuildKit node name')
    # docker/buildx v0.39.1 driver.BuilderName(node.Name), not a caller-supplied container.
    container = 'buildx_buildkit_' + node['Name']
    info = json.loads(subprocess.check_output(
        ['docker', 'container', 'inspect', container], text=True))[0]
    if info.get('Name') != '/' + container or info.get('Config', {}).get('Image') != CONTROLLED_BUILDKIT_IMAGE:
        raise ValueError('Selected BuildKit container/image identity mismatch')
    config = info['HostConfig']
    period, quota = config.get('CpuPeriod', 0), config.get('CpuQuota', 0)
    if not info.get('State', {}).get('Running') or period <= 0 or quota != period * cpus:
        raise ValueError('BuildKit CPU limit is missing or differs from the protocol')
    if config.get('Memory') != memory_bytes or config.get('MemorySwap') != memory_bytes:
        raise ValueError('BuildKit memory/swap limits differ from the protocol')
    host_allowed, host_quota = host_cpu_envelope()
    builder_ancestors = builder_cgroup_envelope(info['State'].get('Pid'))
    if not re.fullmatch('[a-f0-9]{64}', info.get('Id', '')) or info['Id'] not in builder_ancestors['membership']:
        raise ValueError('Host PID membership does not identify the selected BuildKit container')
    boot = subprocess.check_output(['docker', 'exec', container, 'cat', '/proc/sys/kernel/random/boot_id'], text=True).strip()
    if boot != Path('/proc/sys/kernel/random/boot_id').read_text().strip():
        raise ValueError('Selected Docker daemon is not on this measured Linux kernel')
    if ((builder_ancestors['cpuQuotaCpus'] is not None and builder_ancestors['cpuQuotaCpus'] < cpus) or
            (builder_ancestors['memoryMaxBytes'] is not None and builder_ancestors['memoryMaxBytes'] < memory_bytes)):
        raise ValueError('Actual builder ancestor CPU/memory limit is below the protocol')
    status = subprocess.check_output(['docker', 'exec', container, 'cat', '/proc/self/status'], text=True)
    matches = re.findall(r'^Cpus_allowed_list:\s*(.+)$', status, re.MULTILINE)
    if len(matches) != 1:
        raise ValueError('Missing effective container CPU affinity')
    container_allowed = cpu_set(matches[0])
    declared = config.get('CpusetCpus', '')
    if (len(host_allowed) < cpus or len(container_allowed) < cpus or
            not container_allowed.issubset(host_allowed) or
            (declared and len(cpu_set(declared)) < cpus) or
            (host_quota is not None and host_quota < cpus)):
        raise ValueError('Effective or inherited CPU affinity/quota is below the protocol')
    cgroup = subprocess.check_output(['docker', 'exec', container, 'cat',
        '/sys/fs/cgroup/cpu.max', '/sys/fs/cgroup/memory.max',
        '/sys/fs/cgroup/memory.swap.max'], text=True).splitlines()
    if len(cgroup) != 3 or cgroup[0].split() != [str(quota), str(period)] or cgroup[1:] != [str(memory_bytes), '0']:
        raise ValueError('Actual BuildKit cgroup limits differ from the protocol')
    return {'builder': builder, 'driver': selected[0]['Driver'], 'node': node['Name'],
            'endpoint': endpoint, 'container': container, 'containerId': info['Id'],
            'buildkitImage': info['Config']['Image'], 'buildkitVersion': node.get('Version'),
            'cpus': cpus, 'memoryBytes': memory_bytes, 'cpuPeriod': period, 'cpuQuota': quota,
            'memorySwapBytes': config['MemorySwap'], 'cpusetCpus': config.get('CpusetCpus', ''),
            'hostAllowedCpus': sorted(host_allowed), 'containerAllowedCpus': sorted(container_allowed),
            'hostInheritedQuotaCpus': host_quota, 'actualCgroupLimits': cgroup,
            'builderHostPid': info['State']['Pid'], 'builderHostCgroupEnvelope': builder_ancestors,
            'effectiveCpus': cpus, 'verifiedBeforeBuild': True}


def resources():
    memory = {}
    if Path('/proc/meminfo').exists():
        memory = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
    return {'cpus': os.cpu_count(), 'memoryTotal': memory.get('MemTotal', '').strip(),
            'memoryAvailable': memory.get('MemAvailable', '').strip(),
            'loadAverage': list(os.getloadavg()),
            'diskFreeBytes': shutil.disk_usage('.').free}


def build(component, output, builder=None, dockerfile_variant="candidate"):
    dockerfile, context = COMPONENTS[component]
    if dockerfile_variant == "baseline" and component in ("api", "web"):
        dockerfile = f".github/fixtures/onprem-build-baseline/{component}.Dockerfile"
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
    parser.add_argument('--dockerfile-variant', choices=['baseline', 'candidate'], default='candidate')
    parser.add_argument('--builder')
    parser.add_argument('--required-builder-cpus', type=int)
    parser.add_argument('--required-builder-memory', type=int)
    parser.add_argument('--repetitions', type=int, choices=[1, 2, 3], default=1)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    report = {'source': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
        'parallelism': args.parallelism, 'dockerfileVariant': args.dockerfile_variant, 'before': resources(),
        'cachePolicy': 'runner-local only; no external cache imported or published',
        'platform': 'linux/amd64', 'startedAt': time.time(), 'components': []}
    controls = [args.required_builder_cpus, args.required_builder_memory]
    if any(value is not None for value in controls):
        if not all(value is not None for value in controls) or not args.builder:
            parser.error('Paired resource controls require builder, CPU and memory limits')
        if args.required_builder_cpus <= 0 or args.required_builder_memory <= 0:
            parser.error('Builder resource limits must be positive')
        report['buildkitLimits'] = inspect_builder_limits(
            args.builder, args.required_builder_cpus, args.required_builder_memory)
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
                components = list(pool.map(lambda component: build(component, output, args.builder, args.dockerfile_variant), COMPONENTS))
            report['runs'].append({'index': index + 1, 'seconds': round(time.monotonic() - run_started, 3), 'components': components})
            report['components'].extend(components)
            if any(row['exitCode'] != 0 for row in components):
                break
    finally:
        stop.set()
        sampler.join()
    if 'buildkitLimits' in report:
        report['buildkitLimitsAfter'] = inspect_builder_limits(args.builder, args.required_builder_cpus, args.required_builder_memory)
        if report['buildkitLimitsAfter'] != report['buildkitLimits']:
            raise ValueError('BuildKit identity or effective limits changed during timing')
    report['resourceSamples'] = samples
    report.update(seconds=round(time.monotonic() - started, 3), after=resources())
    report['failedBuilds'] = sum(row['exitCode'] != 0 for row in report['components'])
    (args.output / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
    if report['failedBuilds']:
        raise SystemExit('Image build failed; inspect retained component logs')


if __name__ == '__main__':
    main()
