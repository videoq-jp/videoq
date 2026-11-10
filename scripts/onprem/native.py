"""Configuration shared by native K3s GPU installations; no provisioning on import."""
import copy
from k3s import infrastructure, site_values, public_origin, caddyfile
from local_ai import embedding_contract
from common import origin


def local_origin(value):
    """HTTP is limited to the loopback SSH entrypoint, not public interfaces."""
    result = origin(value)
    from urllib.parse import urlsplit
    parsed = urlsplit(result)
    if parsed.scheme != 'http' or parsed.hostname != 'localhost' or not parsed.port or parsed.port < 1024:
        raise ValueError('SSH モードの URL は http://localhost:ポート で指定してください')
    return result


def browser_origin(value):
    return public_origin(value) if origin(value).startswith('https://') else local_origin(value)


def gateway_config(url):
    if browser_origin(url).startswith('https://'):
        return caddyfile(url)
    local_origin(url)
    return '''{
    auto_https off
}
http://:8080 {
    @storage path /videoq-media /videoq-media/*
    handle @storage {
        header {
            Content-Security-Policy "sandbox; default-src 'none'"
            X-Content-Type-Options nosniff
        }
        reverse_proxy garage:3900
    }
    @api path /api /api/* /.well-known/* /health /ready
    handle @api {
        reverse_proxy videoq-api:8787 {
            flush_interval -1
        }
    }
    handle {
        reverse_proxy videoq-web:80
    }
}
http://:8081 {
    respond /healthz 200
}
'''


def backing_plan(example, url, storage_gib, raw):
    if not isinstance(storage_gib, int) or not 10 <= storage_gib <= 10000:
        raise ValueError('動画ストレージは10〜10000 GiBで指定してください')
    config = {name: (example / name).read_text() for name in ('garage.toml', 'elasticmq.conf')}
    config['Caddyfile'] = gateway_config(url)
    objects = infrastructure(raw, config)
    for item in objects:
        name, kind = item['metadata']['name'], item['kind']
        if kind == 'PersistentVolumeClaim' and name == 'garage-data':
            item['spec']['resources']['requests']['storage'] = f'{storage_gib}Gi'
        if kind == 'Service' and name == 'videoq-gateway':
            item['spec']['type'] = 'ClusterIP'
            item['spec']['ports'] = ([{'name': 'https', 'port': 443, 'targetPort': 443}] if url.startswith('https://') else [{'name': 'http', 'port': 8080, 'targetPort': 8080}])
        if kind == 'Deployment' and name == 'videoq-gateway':
            pod = item['spec']['template']['spec']
            pod['containers'][0]['ports'] = [{'containerPort': 443 if url.startswith('https://') else 8080}, {'containerPort': 8081}]
            pod['securityContext'] = {'runAsNonRoot': True, 'runAsUser': 10001, 'runAsGroup': 10001, 'fsGroup': 10001}
            pod['containers'][0]['securityContext'] = {'allowPrivilegeEscalation': False, 'capabilities': {'drop': ['ALL'], 'add': ['NET_BIND_SERVICE']}}
    return config, objects


def application_values(url):
    values = site_values(browser_origin(url))
    values['api']['resources']['limits']['memory'] = '1Gi'
    values['worker']['resources'] = {'requests': {'cpu': '1', 'memory': '1Gi'}, 'limits': {'cpu': '2', 'memory': '4Gi'}}
    return values


def forwarding_units(port, cluster_ip, public_https=False):
    import ipaddress
    if not isinstance(port, int) or not ((public_https and port == 443) or (not public_https and 1024 <= port <= 65535)):
        raise ValueError('SSH 用のポートは1024〜65535で指定してください')
    address = ipaddress.ip_address(cluster_ip)
    upstream = 443 if public_https else 8080
    target = f'[{address}]:{upstream}' if address.version == 6 else f'{address}:{upstream}'
    listener = '0.0.0.0' if public_https else '127.0.0.1'
    # Ordinary TCP avoids kubectl/SPDY stream stalls during large video requests.
    return {
        'videoq-port-forward.socket': f"""[Unit]
Description=VideoQ private browser listener
After=k3s.service
Requires=k3s.service

[Socket]
ListenStream={listener}:{port}
NoDelay=true

[Install]
WantedBy=sockets.target
""",
        'videoq-port-forward.service': f"""[Unit]
Description=VideoQ private browser TCP proxy
After=k3s.service
Requires=k3s.service videoq-port-forward.socket

[Service]
ExecStart=/lib/systemd/systemd-socket-proxyd {target}
DynamicUser=yes
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
Restart=on-failure
RestartSec=2
"""}


def model_contract(objects):
    # The Kubernetes API omits value:"" in live EnvVars; client rendering retains it.
    normalized = copy.deepcopy(objects)
    for obj in normalized:
        if obj.get('kind') != 'Deployment':
            continue
        spec = obj['spec']['template']['spec']
        for container in spec.get('containers', []) + spec.get('initContainers', []):
            for item in container.get('env', []):
                if 'valueFrom' not in item:
                    item.setdefault('value', '')
    return embedding_contract(normalized)
