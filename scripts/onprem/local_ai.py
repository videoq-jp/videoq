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


def validate_served_model(pod, provisioner, revision, filename):
    server=pod['containers'][0]
    expected='/models/'+revision+('/'+filename if filename else '')
    def model_mount(container):
        if any(m.get('mountPath','').startswith('/models/') for m in container.get('volumeMounts',[])):
            raise ValueError('Nested mount overrides provisioned model path')
        mounts=[m for m in container.get('volumeMounts',[]) if m.get('mountPath')=='/models']
        if len(mounts)!=1 or any(m.get('subPath') or m.get('subPathExpr') for m in mounts):
            raise ValueError('Ambiguous model volume mount')
        return mounts[0]
    source,target=model_mount(provisioner),model_mount(server)
    if source['name']!=target['name'] or target.get('readOnly') is not True:
        raise ValueError('Server model mount differs from provisioned volume')
    if len([v for v in pod.get('volumes',[]) if v['name']==source['name']])!=1:
        raise ValueError('Missing or ambiguous provisioned volume')
    if provisioner.get('command')!=['python','provision.py'] or provisioner.get('args'):
        raise ValueError('Unverified model provisioner command')
    args=server.get('args',[])
    if not all(isinstance(arg,str) for arg in args):raise ValueError('Malformed server arguments')
    llama=bool(filename)
    if llama:
        if server.get('command'):raise ValueError('Unexpected GGUF server command')
        remaining=args
        allowed={'--model','--alias','--host','--port','--ctx-size','--threads','--parallel','--gpu-layers','--pooling'}
        switches={'--offline','--embedding'}
    else:
        if server.get('command')!=['vllm','serve'] or not args or args[0]!=expected:
            raise ValueError('Server snapshot target differs from provisioned revision')
        remaining=args[1:]
        allowed={'--served-model-name','--host','--port','--max-model-len','--gpu-memory-utilization','--max-num-seqs','--dtype','--cpu-offload-gb','--generation-config','--runner','--limit-mm-per-prompt','--attention-backend','--pooler-config','--convert','--hf-overrides'}
        switches={'--enforce-eager'}
    parsed={}; index=0
    while index<len(remaining):
        flag=remaining[index]
        if flag in parsed or flag not in allowed|switches:
            raise ValueError('Duplicate or unsupported model/runtime selector: '+flag)
        if flag in switches:parsed[flag]=True;index+=1;continue
        if index+1>=len(remaining) or remaining[index+1].startswith('-'):
            raise ValueError('Missing model/runtime argument')
        parsed[flag]=remaining[index+1];index+=2
    if llama and (parsed.get('--model')!=expected or parsed.get('--pooling')!='last' or not parsed.get('--embedding') or not parsed.get('--offline')):
        raise ValueError('GGUF model target or embedding contract differs')
    if not llama and parsed.get('--runner')!='pooling':raise ValueError('Expected embedding pooling runner')
    # Only vector semantics enter identity: credentials, endpoints and scheduling
    # settings are operational and must not force adoption of another vector space.
    operational_env={'PYTHONPATH','TORCHDYNAMO_DISABLE','HF_HUB_OFFLINE','TRANSFORMERS_OFFLINE',
                     'HF_HUB_DISABLE_TELEMETRY','VLLM_NO_USAGE_STATS','DO_NOT_TRACK','HOME',
                     'VLLM_CONFIG_ROOT','VLLM_CACHE_ROOT','HF_TOKEN','HUGGING_FACE_HUB_TOKEN',
                     'VLLM_API_KEY','OPENAI_API_KEY','API_KEY'}
    environment=server.get('env',[])
    if len({entry['name'] for entry in environment})!=len(environment) or any(entry['name'] not in operational_env for entry in environment):
        raise ValueError('Unsupported or ambiguous embedding server environment')
    semantic_flags={'--ctx-size','--max-model-len','--pooling','--embedding','--dtype',
                    '--pooler-config','--hf-overrides','--convert','--runner','--limit-mm-per-prompt'}
    material={'engine':'llamacpp' if llama else 'vllm',
              'vectorOptions':{flag:value for flag,value in parsed.items() if flag in semantic_flags}}
    return hashlib.sha256(json.dumps(material,sort_keys=True).encode()).hexdigest()


def embedding_runtime_identity(objects, profile):
    deployments=[o for o in objects if o['kind']=='Deployment' and o['metadata']['name'].endswith('-embedding')]
    if len(deployments)!=1:
        raise ValueError('Expected exactly one rendered embedding deployment')
    pod=deployments[0]['spec']['template']['spec']
    provisioners=[c for c in pod.get('initContainers',[]) if c['name']=='provision-model']
    if len(provisioners)!=1 or len(pod['containers'])!=1:
        raise ValueError('Expected one immutable embedding model provisioner/server')
    entries=provisioners[0].get('env',[])
    names=[entry['name'] for entry in entries]
    if len(names)!=len(set(names)):
        raise ValueError('Ambiguous provisioned embedding metadata')
    env={entry['name']:entry.get('value') for entry in entries}
    if any(not isinstance(env.get(key),str) for key in ['MODEL_REPO','MODEL_REVISION','MODEL_FILE','MODEL_SHA256']):
        raise ValueError('Missing explicit provisioned embedding metadata')
    revision=env.get('MODEL_REVISION',''); repo=env.get('MODEL_REPO','')
    if not re.fullmatch(r'[0-9a-f]{40}',revision) or not repo or any(c.isspace() for c in repo):
        raise ValueError('Embedding model requires immutable repository revision')
    contracts={'second-state/gte-Qwen2-1.5B-instruct-GGUF':('openai',1536),
               'Qwen/Qwen3-Embedding-4B':('openai',1536),
               'google/embeddinggemma-2':('embeddinggemma2',768)}
    if repo not in contracts or contracts[repo][0]!=profile:
        raise ValueError('Unsupported or mismatched embedding model/profile/dimension contract')
    if repo=='second-state/gte-Qwen2-1.5B-instruct-GGUF' and not env['MODEL_FILE']:
        raise ValueError('GGUF embedding requires actual served model file')
    if env['MODEL_FILE'] and (env['MODEL_FILE'].startswith('/') or '..' in Path(env['MODEL_FILE']).parts):
        raise ValueError('Model file escapes provisioned revision')
    identity=repo+'@'+revision
    if env.get('MODEL_FILE'):
        checksum=env.get('MODEL_SHA256','')
        if not re.fullmatch(r'[0-9a-f]{64}',checksum):
            raise ValueError('GGUF embedding identity requires actual model checksum')
        identity+=':sha256:'+checksum
    runtime_hash=validate_served_model(pod,provisioners[0],revision,env['MODEL_FILE'])
    identity+=':runtime-sha256:'+runtime_hash
    args=pod['containers'][0].get('args',[])
    if repo=='Qwen/Qwen3-Embedding-4B':
        if args.count('--hf-overrides')!=1:
            raise ValueError('Qwen embedding requires explicit 1536 dimensional contract')
        try: dimensions=json.loads(args[args.index('--hf-overrides')+1]).get('matryoshka_dimensions')
        except (IndexError,ValueError,AttributeError) as error: raise ValueError('Malformed embedding dimensions') from error
        if dimensions!=[1536]:raise ValueError('Mismatched embedding dimensions')
    positions=[i for i,arg in enumerate(args) if arg in ['--alias','--served-model-name']]
    if len(positions)!=1 or positions[0]+1>=len(args) or not str(args[positions[0]+1]).strip():
        raise ValueError('Expected exactly one served embedding alias')
    return {'embeddingModel':args[positions[0]+1],'embeddingRevision':identity,'embeddingPreprocessing':'raw-text-v1','embeddingProfile':profile}


def validate_embedding_overrides(values, identity):
    for key,value in values.get('ai',{}).items():
        if key in identity and value and value!=identity[key]:
            raise ValueError('Application override disagrees with served embedding identity: '+key)


class LocalAI:
    def prepare_inference(self):
        if self.ai == 'openai':
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
        self.ai_identity_overlay = folder / 'embedding-identity.json'
        identity=embedding_runtime_identity(self.ai_plan, 'openai')
        app_values = self.desired_application_values()
        validate_embedding_overrides(app_values, identity)
        private_json(self.ai_identity_overlay, {'ai':identity})
        if getattr(self.args, 'command', 'install') == 'update':
            live = json.loads(self.kube('get', 'deployments', '-o', 'json', capture=True))['items']
            recorded = self.state.get('pending_update', {}).get('runtime', {}).get('deployments', {})
            for component, suffix in [('api', 'api'), ('web', 'web'), ('worker', 'worker'), ('backgroundWorker', 'background-worker')]:
                name = 'videoq-' + suffix
                current = next((d for d in live if d['metadata']['name'] == name), None)
                if name in recorded or current:
                    app_values.setdefault(component, {})['replicas'] = (recorded[name]['replicas'] if name in recorded else current['spec'].get('replicas', 1))
        app_site = folder / 'application-site.json'
        private_json(app_site, app_values)
        app_raw = self.run('helm', 'template', 'videoq', str(self.chart), '-n', 'videoq', '-f', str(app_site),
                           '-f', str(self.ai_app_overlay), '-f', str(self.images), '-f', str(self.ai_identity_overlay), capture=True)
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
            raise ValueError('digest 固定の上流 NVIDIA 推論イメージは amd64 専用です')
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
        if self.ai == 'openai':
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
        if self.ai == 'openai':
            return []
        if not hasattr(self, 'ai_app_overlay'):
            self.prepare_inference()
        return ['-f', str(self.ai_app_overlay), '-f', str(self.ai_identity_overlay)]
