"""Run actual Moodle pairing/media/AI UI inside the parent real-CPU cluster."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import socket
import time
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


runtime = module('moodle_runtime', 'moodle-cpu-runtime.py')
install = module('moodle_install', 'moodle-install-acceptance.py')


def api_ca_patch():
    return {'spec': {'template': {'spec': {
        'volumes': [{'name': 'moodle-cpu-ca', 'configMap': {'name': 'moodle-cpu-ca'}}],
        'containers': [{'name': 'api',
            'env': [{'name': 'NODE_EXTRA_CA_CERTS', 'value': '/moodle-cpu-ca/root.crt'}],
            'volumeMounts': [{'name': 'moodle-cpu-ca', 'mountPath': '/moodle-cpu-ca', 'readOnly': True}]}]}}}}


def configure_api(moodle, output, chart):
    moodle.assert_owner()
    values = json.loads((output / 'values.json').read_text())
    if values.get('publicUrl') != 'http://127.0.0.1:18787':
        raise ValueError('Expected the parent baseline fixture origin before Moodle setup')
    values['publicUrl'] = 'https://videoq.localhost:18443'
    values['storage']['endpoint'] = 'https://storage.videoq.localhost:18443'
    # Keep the parent's actual CPU endpoints/models; introduce no provider keys.
    if values['ai'].get('openaiBaseUrl') != 'http://videoq-inference-chat:8000/v1':
        raise ValueError('Moodle acceptance requires the actual parent CPU inference services')
    profile = values['ai'].get('embeddingProfile', 'openai')
    if profile not in ['openai', 'embeddinggemma2']:
        raise ValueError('Unknown parent embedding storage profile')
    extra = [entry for entry in values['api'].get('extraEnv', []) if entry['name'] != 'LTI_CONFIG']
    values['api']['trustedProxyHops'] = 1
    values['api']['extraEnv'] = [*extra, {'name': 'LTI_CONFIG', 'value': json.dumps({
        'toolOrigin': values['publicUrl'], 'databaseRegistrations': True,
        'privacyEnabled': True, 'auditRetentionDays': 30, 'registrations': []})}]
    path = moodle.output / 'values.json'
    path.write_text(json.dumps(values))
    subprocess.run([os.environ.get('HELM_BIN', 'helm'), 'upgrade', 'videoq', str(chart),
                    '--kubeconfig', str(moodle.kubeconfig), '--kube-context', 'kind-' + runtime.CLUSTER,
                    '--namespace', runtime.NAMESPACE, '-f', str(path), '--wait', '--timeout', '5m'],
                   check=True, capture_output=True, text=True, timeout=330)
    # The chart's app containers are readonly. Mount only the disposable PUBLIC
    # CA, preserving all existing security context, envFrom and model settings.
    moodle.k('patch', 'deployment', 'videoq-api', '--type=strategic', '-p', json.dumps(api_ca_patch()))
    moodle.k('rollout', 'status', 'deployment/videoq-api', '--timeout=300s', timeout=330)
    for cron in ['videoq-maintenance', 'videoq-retention']:
        moodle.k('patch', 'cronjob', cron, '--type=merge', '-p', '{"spec":{"suspend":true}}')
    return 'scene_embeddings_768' if profile == 'embeddinggemma2' else 'scene_embeddings'


def rehearse(kubeconfig, output, chart):
    output = Path(output).resolve()
    owner = uuid4().hex
    prefix = ['kubectl', '--kubeconfig', str(kubeconfig), '--context', 'kind-' + runtime.CLUSTER,
              '-n', runtime.NAMESPACE]
    # Called only by the parent after it created this fresh dedicated cluster.
    # create (not apply) refuses an earlier run's owner marker.
    marker = runtime.resource('ConfigMap', runtime.OWNER_MAP, owner, data={'owner': owner})
    subprocess.run([*prefix, 'create', '-f', '-'], input=json.dumps(marker),
                   text=True, capture_output=True, check=True, timeout=30)
    moodle = runtime.MoodleRuntime(kubeconfig, output / 'moodle-private', owner)
    installed = moodle.provision(output / 'video.mp4')
    installed_checks = moodle.verify_installed()
    embedding_table = configure_api(moodle, output, chart)
    # Host access is loopback-only. Browser traffic is further restricted to the
    # three test origins. Server-to-server clients use the actual public CA.
    forward = subprocess.Popen([*prefix, 'port-forward', '--address=127.0.0.1',
                                'service/moodle-proxy', '18443:18443'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(30):
            if forward.poll() is not None:
                raise RuntimeError('Owned Moodle loopback forward exited before readiness')
            try:
                with socket.create_connection(('127.0.0.1', 18443), timeout=1):
                    break
            except OSError:
                time.sleep(1)
        else:
            raise RuntimeError('Owned Moodle loopback forward did not become ready')
        state = moodle.output / 'browser-state.json'
        result = output / 'moodle-result.json'
        env = {**os.environ, 'MOODLE_CPU_KUBECONFIG': str(moodle.kubeconfig), 'MOODLE_CPU_OWNER': owner,
               'MOODLE_CPU_PRIVATE': str(moodle.output), 'MOODLE_CPU_EMBEDDING_TABLE': embedding_table}
        log = moodle.output / 'browser.log'
        log.touch(mode=0o600)
        with log.open('w') as stream:
            process = subprocess.run(['node', str(ROOT / '.github/moodle-cpu/acceptance.mjs'),
                                      str(state), str(output / 'e2e-state.json'), str(result)],
                                     env=env, stdout=stream, stderr=stream, timeout=2400)
        if process.returncode:
            stage = json.loads((output / 'moodle-stage.json').read_text()).get('stage') if (output / 'moodle-stage.json').exists() else None
            allowed = {'startup', 'owner-pairing', 'teacher-enable', 'real-moodle-processing', 'fresh-learner-native',
                       'real-native-question', 'personal-history', 'positive-reports', 'same-session-source-enrolment'}
            suffix = stage if stage in allowed else 'unknown'
            raise RuntimeError('Actual Moodle CPU browser acceptance failed at ' + suffix + '; raw browser diagnostic stays private')
        report = json.loads(result.read_text())
        if report.get('status') != 'passed' or not report.get('transcript'):
            raise RuntimeError('Actual Moodle CPU evidence is incomplete')
        report['installed'] = {'checks': installed_checks['checks'],
                               'moodleRevision': installed['moodleRevision'],
                               'companionRevision': installed['companionRevision']}
        return report
    finally:
        forward.terminate()
        forward.wait(timeout=10)
