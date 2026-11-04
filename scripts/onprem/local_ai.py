"""Signed local CPU/NVIDIA inference recipes for the single-VPS installer."""
import hashlib
import json
from pathlib import Path
import re
import tarfile
from decimal import Decimal

from common import json_documents, private_json

PROFILES = {
    'local-cpu': ('local-ai-llamacpp.yaml', 'llamacpp-cpu.yaml'),
    'local-gpu': ('local-ai-vllm.yaml', 'vllm-nvidia.yaml'),
}


def chart_example(chart, chart_name, filename, destination):
    # Read only the selected regular member; never extract archive paths to disk.
    with tarfile.open(chart) as archive:
        try:
            member = archive.getmember(chart_name + '/examples/' + filename)
        except KeyError as error:
            raise ValueError('署名済みリリースに選択した AI プロファイルがありません。対応するリリースを選んでください') from error
        if not member.isfile() or member.size > 128 * 1024:
            raise ValueError('リリースに含まれる AI 設定が不正です')
        data = archive.extractfile(member).read()
    destination.write_bytes(data)
    return destination


def quantity(value, resource):
    match = re.fullmatch(r'(\d+(?:\.\d+)?)([a-zA-Z]*)', str(value))
    if not match:
        raise ValueError('未対応の Kubernetes リソース量です: ' + str(value))
    number, unit = Decimal(match[1]), match[2]
    if resource == 'cpu':
        scale = {'': 1000, 'm': 1, 'u': Decimal('0.001'), 'n': Decimal('0.000001')}
    elif resource == 'memory':
        scale = {'': 1, **{suffix: 1024 ** i for i, suffix in enumerate(('Ki', 'Mi', 'Gi', 'Ti', 'Pi', 'Ei'), 1)},
                 **{suffix: 1000 ** i for i, suffix in enumerate(('k', 'M', 'G', 'T', 'P', 'E'), 1)}}
    else:
        scale = {'': 1}
    if unit not in scale:
        raise ValueError('未対応の Kubernetes リソース単位です: ' + str(value))
    return number * scale[unit]


def pod_requests(spec):
    result = {r: Decimal(0) for r in ('cpu', 'memory', 'nvidia.com/gpu')}
    for container in spec.get('containers', []):
        for resource in result:
            result[resource] += quantity(container.get('resources', {}).get('requests', {}).get(resource, 0), resource)
    for container in spec.get('initContainers', []):
        for resource in result:
            result[resource] = max(result[resource], quantity(container.get('resources', {}).get('requests', {}).get(resource, 0), resource))
    return result


def embedding_contract(objects):
    deployment = next(o for o in objects if o['kind'] == 'Deployment' and o['metadata']['name'].endswith('-embedding'))
    pod = deployment['spec']['template']['spec']
    # Pin weights, revisions, aliases, pooling and dimensions. Image-only security
    # rebuilds and setup downloader changes do not select a different vector space.
    material = {'containers': [{k: c[k] for k in ('command', 'args', 'env') if k in c}
                               for c in pod.get('containers', [])],
                'models': [[e for e in c.get('env', []) if e['name'].startswith('MODEL_')]
                           for c in pod.get('initContainers', [])]}
    return hashlib.sha256(json.dumps(material, sort_keys=True).encode()).hexdigest()


class LocalAI:
    def prepare_inference(self):
        if self.ai == 'openrouter':
            return
        files = PROFILES[self.ai]
        folder = self.inference_chart.parent / ('profile-' + self.ai)
        folder.mkdir(exist_ok=True)
        self.ai_app_overlay = chart_example(self.chart, 'videoq', files[0], folder / 'application.yaml')
        overlay = chart_example(self.inference_chart, 'videoq-inference', files[1], folder / 'inference.yaml')
        extra = {'fullnameOverride': 'videoq-inference', 'networkPolicy': {'clientNamespace': 'videoq', 'clientRelease': 'videoq'}}
        if self.ai == 'local-cpu':
            nodes = json.loads(self.kube('get', 'nodes', '-o', 'json', capture=True))['items']
            arch = nodes[0]['metadata']['labels']['kubernetes.io/arch']
            if arch not in ('amd64', 'arm64'):
                raise ValueError('ローカル CPU 推論は amd64/arm64 が必要です')
            extra['whispercpp'] = {'architecture': arch}
            extra['whisper'] = {'nodeSelector': {'kubernetes.io/arch': arch}}
            extra['servers'] = {name: {'nodeSelector': {'kubernetes.io/arch': arch}} for name in ('chat', 'embedding')}
        override = folder / 'site.json'
        private_json(override, extra)
        self.ai_helm_values = ['-f', str(overlay), '-f', str(override), '-f', str(self.inference_images)]
        raw = self.run('helm', 'template', 'inference', str(self.inference_chart), '-n', 'videoq', *self.ai_helm_values, capture=True)
        self.ai_plan = json_documents(self.kube('create', '--dry-run=client', '--validate=false', '-f', '-', '-o', 'json', data=raw, capture=True))
        contract = embedding_contract(self.ai_plan)
        if self.state.get('ai_embedding_contract', contract) != contract:
            raise ValueError('埋め込みモデルの版・量子化・設定が変わります。自動更新せず、バックアップと再索引を計画してください')
        app_values = self.desired_application_values()
        if getattr(self.args, 'command', 'install') == 'update':
            live = json.loads(self.kube('get', 'deployments', '-o', 'json', capture=True))['items']
            recorded = self.state.get('pending_update', {}).get('runtime', {}).get('deployments', {})
            for component in ('api', 'web', 'worker'):
                name = 'videoq-' + component
                current = next((d for d in live if d['metadata']['name'] == name), None)
                if name in recorded or current:
                    app_values.setdefault(component, {})['replicas'] = (recorded[name]['replicas'] if name in recorded else current['spec'].get('replicas', 1))
        app_site = folder / 'application-site.json'
        private_json(app_site, app_values)
        app_raw = self.run('helm', 'template', 'videoq', str(self.chart), '-n', 'videoq', '-f', str(app_site),
                           '-f', str(self.ai_app_overlay), '-f', str(self.images), capture=True)
        self.ai_app_plan = json_documents(self.kube('create', '--dry-run=client', '--validate=false', '-f', '-', '-o', 'json', data=app_raw, capture=True))
        base = Path(__file__).resolve().parents[2] / 'charts/videoq/examples/single-node/infrastructure.yaml'
        self.ai_infra_plan = json_documents(self.kube('create', '--dry-run=client', '--validate=false', '-f', str(base), '-o', 'json', capture=True))
        self.check_ai_capacity()
        self.ai_contract = contract

    def check_ai_capacity(self):
        nodes = json.loads(self.kube('get', 'nodes', '-o', 'json', capture=True))['items']
        node = next(n for n in nodes if n['metadata']['name'] == 'k3d-' + self.cluster + '-server-0')
        total = {r: quantity(node['status']['allocatable'].get(r, 0), r) for r in ('cpu', 'memory', 'nvidia.com/gpu')}
        if self.ai == 'local-gpu' and node['metadata']['labels'].get('kubernetes.io/arch') != 'amd64':
            raise ValueError('署名済み NVIDIA 推論イメージは amd64 専用です')
        required = {r: Decimal(0) for r in total}
        for obj in self.ai_plan + getattr(self, 'ai_app_plan', []) + getattr(self, 'ai_infra_plan', []):
            if obj['kind'] == 'Deployment':
                for r, amount in pod_requests(obj['spec']['template']['spec']).items():
                    required[r] += amount * obj['spec'].get('replicas', 1)
        pods = json.loads(self.kube('get', 'pods', '--all-namespaces', '-o', 'json', capture=True))['items']
        for pod in pods:
            if pod['spec'].get('nodeName') != node['metadata']['name'] or pod.get('status', {}).get('phase') in ('Succeeded', 'Failed'):
                continue
            labels = pod['metadata'].get('labels', {})
            managed = labels.get('app.kubernetes.io/instance') in ('videoq', 'inference') or labels.get('app') in ('postgres', 'garage', 'queue', 'videoq-gateway')
            if pod['metadata']['namespace'] == 'videoq' and managed:
                continue  # Reserve the desired release below instead of double counting existing replicas.
            for r, amount in pod_requests(pod['spec']).items():
                total[r] -= amount
        for resource in required:
            if required[resource] > total[resource]:
                unit = {'cpu': 'mCPU', 'memory': 'GiB', 'nvidia.com/gpu': 'GPU'}[resource]
                divisor = 1024 ** 3 if resource == 'memory' else 1
                raise ValueError(f'ローカル AI のリソースが不足しています: {resource} 必要 {required[resource] / divisor:.2f} {unit}, '
                                 f'空き {max(Decimal(0), total[resource]) / divisor:.2f} {unit}。' +
                                 ('NVIDIA runtime/device plugin と3つの割り当て可能な GPU が必要です' if resource == 'nvidia.com/gpu' else 'このモデル構成を配置できる CPU・メモリを用意してください'))

    def local_inference(self):
        if self.ai == 'openrouter':
            return
        if not hasattr(self, 'ai_plan'):
            self.prepare_inference()
        self.stage('ローカル AI（Whisper・埋め込み・LLM）を配置します。初回はモデルを取得します')
        self.run('helm', 'upgrade', '--install', 'inference', str(self.inference_chart), '--kubeconfig', str(self.kubeconfig),
                 '-n', 'videoq', *self.ai_helm_values, '--wait', '--timeout', '30m')
        self.state['ai_embedding_contract'] = self.ai_contract
        private_json(self.state_path, self.state)
        private_json(self.directory / 'inference-plan.json', {'apiVersion': 'v1', 'kind': 'List', 'items': self.ai_plan})

    def ai_application_values(self):
        if self.ai == 'openrouter':
            return []
        if not hasattr(self, 'ai_app_overlay'):
            self.prepare_inference()
        return ['-f', str(self.ai_app_overlay)]
