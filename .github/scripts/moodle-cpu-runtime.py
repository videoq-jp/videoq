"""Install real Moodle in the caller's newly owned, offline CPU acceptance cluster.

This module does not create/reuse clusters, select the current context, seed LTI
bindings or fabricate processing results. The parent CPU rehearsal owns cleanup.
Private state stays outside the checkout; only the returned summary is publishable.
"""
import base64
import hashlib
import importlib.util
import ipaddress
import json
from pathlib import Path
import re
import secrets
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
CLUSTER = 'videoq-onprem-lab'
NAMESPACE = 'videoq-validation'
OWNER_MAP = 'videoq-moodle-cpu-owner'
OWNER_LABEL = 'jp.videoq.moodle-cpu-owner'
SPEC = importlib.util.spec_from_file_location('moodle_sources', Path(__file__).with_name('moodle-cpu-sources.py'))
sources = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sources)


def valid_owner(owner):
    if not isinstance(owner, str) or not re.fullmatch('[a-f0-9]{32}', owner):
        raise ValueError('A fresh 32-character acceptance owner is required')
    return owner


def private_directory(output):
    output = Path(output)
    if not output.is_absolute() or output.is_symlink():
        raise ValueError('Use an absolute external private fixture directory')
    resolved = output.resolve()
    if resolved == ROOT or ROOT in resolved.parents or (resolved.exists() and any(resolved.iterdir())):
        raise ValueError('Fixture state must be fresh and outside the checkout')
    resolved.mkdir(mode=0o700, parents=True, exist_ok=True)
    resolved.chmod(0o700)
    return resolved


def dns_with_proxy(corefile, address):
    ip = ipaddress.ip_address(address)
    if ip.version != 4 or ip not in ipaddress.ip_network('10.96.0.0/12'):
        raise ValueError('Proxy must use the owned cluster service subnet')
    if re.search(r'^\s*(?:forward|proxy|hosts)\b', corefile, re.M):
        raise ValueError('Expected isolated CoreDNS without public forwarding or existing hosts')
    if corefile.count('.:53 {') != 1:
        raise ValueError('Unexpected CoreDNS server block')
    hosts = ('\n    hosts {\n        ' + str(ip) +
             ' moodle.localhost videoq.localhost storage.videoq.localhost\n'
             '        ttl 5\n        fallthrough\n    }')
    return corefile.replace('.:53 {', '.:53 {' + hosts, 1)


def node_dns_config():
    # Prefer exact fixture hostnames before namespace search expansion. Retain
    # ClusterFirst nameservers/searches and the existing no-public-forwarding DNS.
    return {'options': [{'name': 'ndots', 'value': '1'}]}


def node_transport_evidence(value):
    """Reconstruct public transport evidence without reflecting external strings."""
    if not isinstance(value, dict) or not isinstance(value.get('nodeVersion'), str) or not re.fullmatch(r'v\d{1,3}\.\d{1,3}\.\d{1,3}', value['nodeVersion']):
        raise ValueError('Missing actual Node transport evidence')
    codes = {'EAI_AGAIN', 'ENOTFOUND', 'ENODATA', 'ESERVFAIL', 'EREFUSED', 'ETIMEOUT', 'ECONNREFUSED', 'ECONNRESET',
             'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ABORT_ERR', 'UND_ERR_CONNECT_TIMEOUT',
             'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
             'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
             'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT'}
    result = {'nodeVersion': value['nodeVersion']}
    if type(value.get('dnsNdots')) is int and 0 <= value['dnsNdots'] <= 15:
        result['dnsNdots'] = value['dnsNdots']
    for phase in ['lookup', 'resolve4', 'tls', 'login', 'oauth']:
        source = value.get(phase)
        if not isinstance(source, dict):
            raise ValueError('Missing Node transport phase')
        row = {'ok': source.get('ok') is True}
        for key in ['proxyMatched', 'lookup', 'connected', 'secure']:
            if type(source.get(key)) is bool:
                row[key] = source[key]
        if type(source.get('httpStatus')) is int and 100 <= source['httpStatus'] <= 599:
            row['httpStatus'] = source['httpStatus']
        if source.get('kind') in ['timeout', 'error']:
            row['kind'] = source['kind']
        if isinstance(source.get('codes'), list):
            row['codes'] = sorted({code for code in source['codes'] if isinstance(code, str) and code in codes})
        result[phase] = row
    result['status'] = 'passed' if (result['lookup']['ok'] and result['lookup'].get('proxyMatched') is True
        and result['resolve4']['ok'] and result['resolve4'].get('proxyMatched') is True
        and result['tls']['ok'] and all(result['tls'].get(key) is True for key in ['lookup', 'connected', 'secure'])
        and result['login']['ok'] and result['login'].get('httpStatus') == 200
        and result['oauth']['ok'] and result['oauth'].get('httpStatus') == 401) else 'failed'
    return result


def resource(kind, name, owner, spec=None, **fields):
    item = {'apiVersion': 'apps/v1' if kind == 'Deployment' else 'v1', 'kind': kind,
            'metadata': {'name': name, 'namespace': NAMESPACE, 'labels': {OWNER_LABEL: valid_owner(owner)}}}
    if spec is not None:
        item['spec'] = spec
    return {**item, **fields}


def volume(name, owner):
    # The single disposable node owns these paths. Static volumes avoid an
    # external helper-image pull by the dynamic provisioner after egress closes.
    pvname = name + '-' + valid_owner(owner)[:12]
    pv = resource('PersistentVolume', pvname, owner, {
        'capacity': {'storage': '2Gi'}, 'accessModes': ['ReadWriteOnce'], 'storageClassName': '',
        'persistentVolumeReclaimPolicy': 'Retain',
        'hostPath': {'path': '/videoq-moodle-cpu/' + owner + '/' + name, 'type': 'DirectoryOrCreate'}})
    del pv['metadata']['namespace']
    return [pv, resource('PersistentVolumeClaim', name, owner, {
        'accessModes': ['ReadWriteOnce'], 'storageClassName': '', 'volumeName': pvname,
        'resources': {'requests': {'storage': '2Gi'}}})]


def deployment(name, owner, container, volumes):
    container['imagePullPolicy'] = 'Never'
    container['resources'] = {'requests': {'cpu': '100m', 'memory': '128Mi'},
                              'limits': {'cpu': '2', 'memory': '1Gi'}}
    return resource('Deployment', name, owner, {
        'replicas': 1, 'selector': {'matchLabels': {'app': name}},
        'template': {'metadata': {'labels': {'app': name, OWNER_LABEL: owner}},
                     'spec': {'automountServiceAccountToken': False,
                              'containers': [container], 'volumes': volumes}}})


def proxy_resources(owner):
    return [*volume('moodle-cpu-data', owner), *volume('moodle-cpu-proxy-data', owner),
            resource('ConfigMap', 'moodle-cpu-proxy', owner,
                     data={'Caddyfile': (ROOT / '.github/moodle-cpu/Caddyfile').read_text()}),
            resource('Service', 'db', owner, {'type': 'ExternalName',
                'externalName': 'postgres.' + NAMESPACE + '.svc.cluster.local'}),
            resource('Service', 'moodle-proxy', owner, {'selector': {'app': 'moodle-proxy'},
                'ports': [{'port': 18443, 'targetPort': 18443}]}),
            deployment('moodle-proxy', owner, {
                'name': 'proxy', 'image': 'videoq-moodle-proxy:onprem-ci',
                'env': [{'name': 'VIDEOQ_API_UPSTREAM', 'value': 'videoq-api:8787'},
                        {'name': 'VIDEOQ_WEB_UPSTREAM', 'value': 'videoq-web:80'},
                        {'name': 'VIDEOQ_STORAGE_UPSTREAM', 'value': 'garage:3900'}],
                'volumeMounts': [{'name': 'config', 'mountPath': '/etc/caddy', 'readOnly': True},
                                 {'name': 'data', 'mountPath': '/data'},
                                 {'name': 'moodle', 'mountPath': '/moodledata', 'readOnly': True}],
                'readinessProbe': {'tcpSocket': {'port': 18443}, 'periodSeconds': 2}},
                [{'name': 'config', 'configMap': {'name': 'moodle-cpu-proxy'}},
                 {'name': 'data', 'persistentVolumeClaim': {'claimName': 'moodle-cpu-proxy-data'}},
                 {'name': 'moodle', 'persistentVolumeClaim': {'claimName': 'moodle-cpu-data'}}])]


def moodle_resources(owner, password, video):
    if not isinstance(video, bytes) or not 32 <= len(video) <= 900_000:
        raise ValueError('Use the small, public spoken-video fixture')
    if not isinstance(password, str) or not re.fullmatch('[a-f0-9]{64}', password):
        raise ValueError('Expected a generated disposable database password')
    checksum = hashlib.sha256(video).hexdigest()
    return [resource('Secret', 'moodle-cpu-runtime', owner, stringData={
                'MOODLE_DB_PASSWORD': password, 'MOODLE_FIXTURE_PASSWORD': 'Cpu-acceptance-' + password + '!'}),
            resource('ConfigMap', 'moodle-cpu-input', owner,
                     binaryData={'video.mp4': base64.b64encode(video).decode()}),
            resource('Service', 'moodle', owner, {'selector': {'app': 'moodle'}, 'ports': [{'port': 80}]}),
            deployment('moodle', owner, {
                'name': 'moodle', 'image': 'videoq-moodle:onprem-ci',
                'envFrom': [{'secretRef': {'name': 'moodle-cpu-runtime'}}],
                'env': [{'name': 'VIDEOQ_MOODLE_CPU_FIXTURE', 'value': '1'},
                        {'name': 'VIDEOQ_MOODLE_CPU_OWNER', 'value': owner},
                        {'name': 'MOODLE_FIXTURE_VIDEO_SHA256', 'value': checksum}],
                'volumeMounts': [{'name': 'data', 'mountPath': '/var/www/moodledata'},
                                 {'name': 'ca', 'mountPath': '/acceptance-ca', 'readOnly': True},
                                 {'name': 'input', 'mountPath': '/acceptance-input', 'readOnly': True}],
                'readinessProbe': {'tcpSocket': {'port': 80}, 'periodSeconds': 2}},
                [{'name': 'data', 'persistentVolumeClaim': {'claimName': 'moodle-cpu-data'}},
                 {'name': 'ca', 'configMap': {'name': 'moodle-cpu-ca'}},
                 {'name': 'input', 'configMap': {'name': 'moodle-cpu-input'}}])]


def verify_roles(action, result):
    """Evaluate actual core authority/availability, not expected fixture rows."""
    roles = result['authority']
    checks = [all(not role['siteAdmin'] for role in roles.values()),
              roles['teacher']['activeEnrolment'], not roles['outsider']['activeEnrolment'],
              roles['teacher']['manageContent'], roles['teacher']['manageActivities'],
              not roles['learner']['manageContent'], not roles['learner']['manageActivities'],
              not roles['learner']['viewReports'],
              roles['teacher']['viewReports'] == (action != 'deny-reports'),
              roles['learner']['activeEnrolment'] == (action != 'suspend'),
              result['status'] == 'off', not result['enabled'], not result['connectionConfigured']]
    if action == 'hide':
        checks += [not roles['learner']['sourceVisible'], roles['teacher']['sourceVisible']]
    elif action != 'suspend':
        checks += [roles['learner']['sourceVisible']]
    if not all(checks):
        raise RuntimeError('Actual Moodle role or source authority did not match the required state: ' + action)
    return len(checks)


def network_failure(raw):
    """Allow only enumerated stages/numeric results; never publish raw errors."""
    for line in raw.splitlines():
        if not line.startswith('VIDEOQ_CPU_NETWORK '):
            continue
        try:
            value = json.loads(line.removeprefix('VIDEOQ_CPU_NETWORK '))
        except ValueError:
            continue
        if value in [{'stage': 'public-tcp'}, {'stage': 'public-dns'}]:
            return value
        if isinstance(value, dict) and set(value) == {'stage', 'curlErrno', 'httpStatus', 'tlsVerifyResult'}:
            if value['stage'] == 'private-https' and all(type(value[key]) is int and -1 <= value[key] <= 65535
                    for key in ['curlErrno', 'httpStatus', 'tlsVerifyResult']):
                return value
    return None


class MoodleRuntime:
    def __init__(self, kubeconfig, output, owner):
        self.owner = valid_owner(owner)
        self.kubeconfig = Path(kubeconfig).resolve(strict=True)
        self.output = private_directory(output)
        self.prefix = ['kubectl', '--kubeconfig', str(self.kubeconfig), '--context', 'kind-' + CLUSTER]
        self.password = secrets.token_hex(32)
        self.browser_state = None
        self.counter = 0

    def k(self, *command, data=None, timeout=60, namespace=NAMESPACE):
        self.counter += 1
        result = subprocess.run([*self.prefix, '-n', namespace, *command], input=data,
                                capture_output=True, text=True, timeout=timeout)
        # Keep raw CLI diagnostics private. Never print Pod specs, secrets,
        # cookies, generated credentials or potentially credentialed error URLs.
        log = self.output / ('command-' + str(self.counter) + '.log')
        log.touch(mode=0o600)
        log.write_text(result.stdout + result.stderr)
        if result.returncode:
            failure = network_failure(result.stdout + result.stderr)
            if failure:
                (self.output / 'failure-summary.json').write_text(json.dumps(failure) + '\n')
                print('Moodle CPU network diagnostic: ' + json.dumps(failure), flush=True)
            raise RuntimeError('Moodle CPU fixture command failed; private diagnostic ' + log.name)
        return result.stdout

    def assert_owner(self):
        actual = self.k('config', 'current-context').strip()
        if actual != 'kind-' + CLUSTER:
            raise ValueError('Use the explicit disposable lab kubeconfig')
        marker = json.loads(self.k('get', 'configmap', OWNER_MAP, '-o', 'json'))
        if marker.get('data') != {'owner': self.owner} or marker.get('metadata', {}).get('labels', {}).get(OWNER_LABEL) != self.owner:
            raise ValueError('The parent must identify its newly created acceptance cluster')

    def apply(self, items):
        self.k('apply', '-f', '-', data=json.dumps({'apiVersion': 'v1', 'kind': 'List', 'items': items}))

    def fixture(self, action):
        self.assert_owner()
        text = self.k('exec', 'deployment/moodle', '--', 'php', '/acceptance/fixture.php', action, timeout=1200)
        if action == 'install':
            return {'installed': True}
        try:
            return json.loads(text)
        except ValueError:
            raise RuntimeError('Moodle fixture emitted diagnostics instead of a strict JSON result') from None

    def provision(self, video_path):
        self.assert_owner()
        existing = self.k('get', 'deployment,service,configmap,secret,pvc',
                          '-o', 'custom-columns=NAME:.metadata.name', '--no-headers').splitlines()
        reserved = {'db', 'moodle', 'moodle-proxy'}
        if any(name.strip() in reserved or name.strip().startswith('moodle-cpu-') for name in existing):
            raise RuntimeError('Moodle CPU resources already exist; refusing to adopt or replace them')
        video = Path(video_path).read_bytes()
        items = moodle_resources(self.owner, self.password, video)  # Validate before mutation.
        # The official Postgres image briefly starts a socket-only bootstrap
        # server. A socket pg_isready can succeed just before that server stops.
        self.k('exec', 'deployment/postgres', '--', 'sh', '-ceu',
               'for attempt in $(seq 1 60); do if pg_isready -h 127.0.0.1 -U postgres >/dev/null; '
               'then exit 0; fi; sleep 1; done; exit 1', timeout=90)
        roles = self.k('exec', '-i', 'deployment/postgres', '--', 'psql', '-U', 'postgres', '-At',
                       '-v', 'ON_ERROR_STOP=1', data="SELECT count(*) FROM pg_roles WHERE rolname='moodle';\n"
                       "SELECT count(*) FROM pg_database WHERE datname='moodle';\n")
        if roles.strip().splitlines() != ['0', '0']:
            raise RuntimeError('Moodle database or role already exists; refusing to adopt it')
        self.k('exec', '-i', 'deployment/postgres', '--', 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1',
               data="CREATE ROLE moodle LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '" + self.password + "';\n")
        self.k('exec', 'deployment/postgres', '--', 'createdb', '-U', 'postgres', '-O', 'moodle', 'moodle')
        privileges = self.k('exec', '-i', 'deployment/postgres', '--', 'psql', '-U', 'postgres', '-At',
                            '-v', 'ON_ERROR_STOP=1', data="SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls "
                            "FROM pg_roles WHERE rolname='moodle';\n").strip()
        if privileges != 'f|f|f|f':
            raise RuntimeError('Moodle database role has unexpected privileges')
        self.apply(proxy_resources(self.owner))
        self.k('rollout', 'status', 'deployment/moodle-proxy', '--timeout=180s', timeout=200)
        cert = self.k('exec', 'deployment/moodle-proxy', '--', 'cat', '/data/caddy/pki/authorities/local/root.crt')
        if not cert.startswith('-----BEGIN CERTIFICATE-----\n') or 'PRIVATE KEY' in cert:
            raise RuntimeError('Expected only the disposable public root CA')
        ca = self.output / 'root.crt'
        ca.write_text(cert)
        self.apply([resource('ConfigMap', 'moodle-cpu-ca', self.owner, data={'root.crt': cert})])
        address = json.loads(self.k('get', 'service', 'moodle-proxy', '-o', 'json'))['spec']['clusterIP']
        dns = json.loads(self.k('get', 'configmap', 'coredns', '-o', 'json', namespace='kube-system'))
        corefile = dns_with_proxy(dns['data']['Corefile'], address)
        self.k('patch', 'configmap', 'coredns', '--type=merge', '-p',
               json.dumps({'data': {'Corefile': corefile}}), namespace='kube-system')
        self.k('rollout', 'restart', 'deployment/coredns', namespace='kube-system')
        self.k('rollout', 'status', 'deployment/coredns', '--timeout=120s', timeout=150, namespace='kube-system')
        self.apply(items)
        self.k('rollout', 'status', 'deployment/moodle', '--timeout=180s', timeout=200)
        self.fixture('install')
        seeded = self.fixture('seed')
        # Pass browser credentials through a pipe; never persist the password.
        self.browser_state = {'owner': self.owner, 'password': 'Cpu-acceptance-' + self.password + '!', **seeded}
        return {'moodleRevision': sources.read_pins()['moodle']['revision'],
                'companionRevision': sources.read_pins()['companion']['revision'],
                'databaseRole': 'moodle; no superuser, create-role or create-database privilege',
                'publicVideoSha256': hashlib.sha256(video).hexdigest(),
                'seed': seeded, 'limits': ['Installed Moodle and ordinary role/media fixtures only; '
                                         'connection, real AI and browser acceptance are separate gates.']}

    def verify_installed(self):
        stages = {}
        checks = 0
        for action in ['status', 'hide', 'show', 'suspend', 'resume', 'deny-reports', 'allow-reports', 'tick']:
            result = self.fixture(action)
            checks += verify_roles(action, result)
            stages[action] = result
        network = self.fixture('network')['network']
        if network != {'privateHttps': True, 'peerCertificateVerified': True, 'publicIpAndDnsBlocked': True}:
            raise RuntimeError('Actual Moodle HTTPS/egress checks did not pass')
        return {'stages': stages, 'checks': checks + 3, 'network': network}

    def verify_node_transport(self):
        """Exercise the API's pinned Node base without models, app sessions or secrets."""
        self.assert_owner()
        name = 'moodle-cpu-node-transport'
        existing = self.k('get', 'pod', name, '--ignore-not-found', '-o', 'name')
        existing += self.k('get', 'configmap', name, '--ignore-not-found', '-o', 'name')
        if existing.strip():
            raise RuntimeError('Refusing to adopt an existing Node transport probe')
        address = json.loads(self.k('get', 'service', 'moodle-proxy', '-o', 'json'))['spec']['clusterIP']
        if ipaddress.ip_address(address) not in ipaddress.ip_network('10.96.0.0/12'):
            raise RuntimeError('Unexpected owned proxy address')
        self.apply([resource('ConfigMap', name, self.owner,
            data={'transport-probe.mjs': (ROOT / '.github/moodle-cpu/transport-probe.mjs').read_text()}),
            resource('Pod', name, self.owner, {
                'restartPolicy': 'Never', 'activeDeadlineSeconds': 120, 'automountServiceAccountToken': False,
                'dnsConfig': node_dns_config(),
                'securityContext': {'runAsNonRoot': True, 'runAsUser': 1000, 'runAsGroup': 1000},
                'containers': [{'name': 'node', 'image': 'videoq-moodle-node:onprem-ci', 'imagePullPolicy': 'Never',
                    'command': ['node', '/probe/transport-probe.mjs'],
                    'env': [{'name': 'VIDEOQ_MOODLE_TRANSPORT_PROBE', 'value': '1'},
                            {'name': 'VIDEOQ_MOODLE_EXPECTED_PROXY', 'value': address},
                            {'name': 'NODE_EXTRA_CA_CERTS', 'value': '/public-ca/root.crt'}],
                    'securityContext': {'readOnlyRootFilesystem': True, 'allowPrivilegeEscalation': False,
                                        'capabilities': {'drop': ['ALL']}},
                    'resources': {'requests': {'cpu': '100m', 'memory': '64Mi'},
                                  'limits': {'cpu': '1', 'memory': '256Mi'}},
                    'volumeMounts': [{'name': 'script', 'mountPath': '/probe', 'readOnly': True},
                                     {'name': 'ca', 'mountPath': '/public-ca', 'readOnly': True}]}],
                'volumes': [{'name': 'script', 'configMap': {'name': name, 'defaultMode': 0o444}},
                            {'name': 'ca', 'configMap': {'name': 'moodle-cpu-ca', 'defaultMode': 0o444}}]})])
        for _ in range(140):
            phase = self.k('get', 'pod', name, '-o', 'jsonpath={.status.phase}').strip()
            if phase in ['Succeeded', 'Failed']:
                break
            time.sleep(1)
        else:
            raise RuntimeError('Owned Node transport probe did not terminate')
        raw = self.k('logs', 'pod/' + name)
        log = self.output / 'node-transport.log'
        log.touch(mode=0o600)
        log.write_text(raw)
        candidates = []
        for line in raw.splitlines():
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict) and 'nodeVersion' in value:
                candidates.append(value)
        if len(candidates) != 1:
            raise RuntimeError('Missing bounded Node transport report; raw log stays private')
        report = node_transport_evidence(candidates[0])
        if phase != 'Succeeded':
            report['status'] = 'failed'
        return report
