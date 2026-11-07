"""Rehearse the installed Moodle layer before attaching the real CPU pipeline.

Requires a freshly built pinned Moodle fixture image, kind, kubectl and ffmpeg.
This installs Moodle and evaluates current roles/visibility/enrolment and verified
private HTTPS. It performs no model downloads or AI calls. Full CPU acceptance
retains its separate 10 GiB prerequisite and is not satisfied by this check.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


cpu = module('moodle_cpu_parent', 'onprem-cpu-acceptance.py')
runtime = module('moodle_runtime', 'moodle-cpu-runtime.py')


def check_image(image, pins):
    if not re.fullmatch(r'videoq-moodle:[a-zA-Z0-9_.-]+', image):
        raise ValueError('Use a locally built Moodle test image')
    info = json.loads(subprocess.check_output(['docker', 'image', 'inspect', image], text=True, timeout=60))[0]
    expected = {'jp.videoq.test-only': 'moodle-cpu-acceptance',
                'jp.videoq.moodle-revision': pins['moodle']['revision'],
                'jp.videoq.companion-revision': pins['companion']['revision']}
    if any(info.get('Config', {}).get('Labels', {}).get(key) != value for key, value in expected.items()):
        raise ValueError('Moodle image source labels differ from reviewed pins')
    return info['Id']


def node_image(dockerfile=ROOT / 'apps/api/Dockerfile'):
    matches = re.findall(r'^FROM (node:\d+\.\d+\.\d+-alpine@sha256:[a-f0-9]{64}) AS base$',
                         Path(dockerfile).read_text(), re.M)
    if len(matches) != 1:
        raise ValueError('Expected one reviewed digest-pinned API Node base')
    return matches[0]


def run(output, image):
    output = runtime.private_directory(output)
    def command(parts, **options):
        options.setdefault('timeout', 180)
        return subprocess.check_output(parts, cwd=ROOT, text=True, **options).strip()
    if cpu.CLUSTER in command(['kind', 'get', 'clusters']).splitlines():
        raise RuntimeError('The disposable acceptance cluster already exists; refusing to replace it')
    memory = int(command(['docker', 'info', '--format', '{{.MemTotal}}']))
    if memory < 4 * 1024**3:
        raise RuntimeError('Installed Moodle fixture requires 4 GiB; no cluster or images were provisioned')
    if not shutil.which('ffmpeg'):
        raise RuntimeError('Install ffmpeg on the test host; no cluster or images were provisioned')
    pins = runtime.sources.read_pins()
    image_id = check_image(image, pins)
    fixture = json.loads((ROOT / '.github/onprem-lab/dependencies.json').read_text())
    offline, backing = cpu.lab.prepare_fixtures(fixture, 'onprem-ci')
    references = {'moodle': image, 'moodle-proxy': pins['proxyImage'], 'moodle-node': node_image(),
                  'lab-postgres': backing['postgres']['reference']}
    anonymous = output / 'anonymous'
    anonymous.mkdir(mode=0o700)
    (anonymous / 'config.json').write_text('{"auths":{}}\n')
    public_env = {**os.environ, 'DOCKER_CONFIG': str(anonymous)}
    try:
        for reference in [cpu.NODE, references['moodle-proxy'], references['lab-postgres'], references['moodle-node']]:
            subprocess.run(['docker', 'pull', reference], env=public_env, check=True, timeout=600)
        for component, reference in references.items():
            command(['docker', 'tag', reference, 'videoq-' + component + ':onprem-ci'])
        if json.loads((anonymous / 'config.json').read_text()) != {'auths': {}}:
            raise RuntimeError('Anonymous registry configuration was changed')
    finally:
        (anonymous / 'config.json').unlink(missing_ok=True)
        anonymous.rmdir()
    audio = ROOT / 'apps/inference/whisper/tests/fixtures/fleurs-ja-00.mp3'
    case = json.loads(audio.with_suffix('.json').read_text())
    if hashlib.sha256(audio.read_bytes()).hexdigest() != case['sha256']:
        raise ValueError('Public Japanese speech checksum mismatch')
    video = output / 'video.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x120:d=10.44',
                    '-i', str(audio), '-shortest', '-c:v', 'libx264', '-c:a', 'aac',
                    '-movflags', 'frag_keyframe+empty_moov', str(video)], check=True, timeout=120)
    owner = uuid4().hex
    network = 'videoq-moodle-cpu-' + owner[:12]
    kubeconfig = output / 'kubeconfig'
    config = output / 'kind.json'
    config.write_text(json.dumps({'kind': 'Cluster', 'apiVersion': 'kind.x-k8s.io/v1alpha4',
        'networking': {'podSubnet': cpu.POD_SUBNET, 'serviceSubnet': cpu.SERVICE_SUBNET},
        'nodes': [{'role': 'control-plane'}]}))
    created = False
    command(['docker', 'network', 'create', '--label', runtime.OWNER_LABEL + '=' + owner, network])
    env = {**os.environ, 'KIND_EXPERIMENTAL_DOCKER_NETWORK': network, 'KUBECONFIG': str(kubeconfig)}
    try:
        created = True  # Cover partially failed kind bootstrap too.
        subprocess.run(['kind', 'create', 'cluster', '--name', cpu.CLUSTER, '--config', str(config),
                        '--image', cpu.NODE, '--kubeconfig', str(kubeconfig), '--wait', '180s', '--retain'], env=env, check=True, timeout=300)
        kubeconfig.chmod(0o600)
        networks = json.loads(command(['docker', 'inspect', cpu.CLUSTER + '-control-plane']))[0]['NetworkSettings']['Networks']
        if set(networks) != {network}:
            raise RuntimeError('Acceptance node must attach only to its dedicated network')
        prefix = ['kubectl', '--kubeconfig', str(kubeconfig), '--context', 'kind-' + cpu.CLUSTER]
        def k(*parts, data=None):
            return command([*prefix, *parts], input=data)
        dns = json.loads(k('-n', 'kube-system', 'get', 'configmap', 'coredns', '-o', 'json'))
        corefile, count = re.subn(r'forward\s+\.\s+/etc/resolv.conf\s*\{[^}]*\}', '', dns['data']['Corefile'])
        if count != 1:
            raise RuntimeError('Unexpected CoreDNS; cannot guarantee public DNS forwarding is blocked')
        k('-n', 'kube-system', 'patch', 'configmap', 'coredns', '--type=merge', '-p', json.dumps({'data': {'Corefile': corefile}}))
        k('-n', 'kube-system', 'rollout', 'restart', 'deployment/coredns')
        k('-n', 'kube-system', 'rollout', 'status', 'deployment/coredns', '--timeout=120s')
        imports = cpu.lab.load_native_images(['videoq-' + component + ':onprem-ci' for component in references], env, output, cluster=cpu.CLUSTER)
        firewall = cpu.isolate_node(json.loads(command(['docker', 'network', 'inspect', network]))[0])
        selected = [item for item in offline['items'] if item['kind'] == 'Namespace' or item['metadata']['name'] == 'postgres']
        selected += [runtime.resource('ConfigMap', runtime.OWNER_MAP, owner, data={'owner': owner})]
        k('apply', '-f', '-', data=json.dumps({'apiVersion': 'v1', 'kind': 'List', 'items': selected}))
        k('-n', runtime.NAMESPACE, 'rollout', 'status', 'deployment/postgres', '--timeout=180s')
        moodle = runtime.MoodleRuntime(kubeconfig, output / 'private', owner)
        report = moodle.provision(video)
        report['installedAcceptance'] = moodle.verify_installed()
        report.update({'moodleImageId': image_id, 'nativeImageImports': imports,
                       'dockerMemoryBytes': memory, 'publicEgressFirewall': firewall,
                       'nodeImageReference': references['moodle-node']})
        (output / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
        transport = moodle.verify_node_transport()
        version_matches = transport['nodeVersion'] == 'v' + references['moodle-node'].split(':', 1)[1].split('-', 1)[0]
        if not version_matches:
            transport['status'] = 'failed'
        (output / 'node-transport.json').write_text(json.dumps(transport, indent=2) + '\n')
        report['nodeTransport'] = transport
        (output / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
        print('NODE_MOODLE_TRANSPORT ' + json.dumps(transport), flush=True)
        if not version_matches:
            raise RuntimeError('Node transport version differs from the pinned API base')
        if transport['status'] != 'passed':
            raise RuntimeError('Actual Node DNS/TLS/HTTP to Moodle failed; see bounded node-transport.json')
        print(json.dumps({'installedMoodle': 'passed', 'checks': report['installedAcceptance']['checks'],
                          'limits': report['limits']}), flush=True)
        return report
    except Exception:
        cpu.capture_diagnostics(kubeconfig, output)
        raise
    finally:
        if created:
            # Never delete an arbitrary node selected by a current kube context.
            inspected = subprocess.run(['docker', 'inspect', cpu.CLUSTER + '-control-plane'], capture_output=True, text=True, timeout=30)
            if inspected.returncode == 0:
                identity = json.loads(inspected.stdout)[0]
                if set(identity['NetworkSettings']['Networks']) != {network}:
                    raise RuntimeError('Cleanup node ownership mismatch')
                subprocess.run(['kind', 'delete', 'cluster', '--name', cpu.CLUSTER, '--kubeconfig', str(kubeconfig)], env=env, check=True, timeout=180)
        marker = command(['docker', 'network', 'inspect', network, '--format', '{{index .Labels "' + runtime.OWNER_LABEL + '"}}'])
        if marker != owner:
            raise RuntimeError('Cleanup network ownership mismatch')
        subprocess.run(['docker', 'network', 'rm', network], check=True, timeout=30)
        (output / 'cleanup.json').write_text(json.dumps({'ownedClusterAndNetworkRemoved': True}) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    parser.add_argument('--image', default='videoq-moodle:cpu-acceptance')
    args = parser.parse_args()
    run(args.output, args.image)
