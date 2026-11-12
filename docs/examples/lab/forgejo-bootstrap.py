"""Render the proven single-host Forgejo manifest; apply it separately."""

import argparse
import ipaddress
import json
import os
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--listen-ip", required=True)
parser.add_argument("--directory", type=Path, default=Path("/var/lib/videoq-forgejo"))
args = parser.parse_args()
listen_ip = str(ipaddress.IPv4Address(args.listen_ip))
if not args.directory.is_absolute():
    parser.error("--directory must be absolute")
root = args.directory
root.mkdir(mode=0o700, exist_ok=True)
for directory in ["data", "config"]:
    p = root / directory
    p.mkdir(mode=0o700, exist_ok=True)
    os.chown(p, 1000, 1000)
env = {
    "FORGEJO__security__INSTALL_LOCK": "true",
    "FORGEJO__service__DISABLE_REGISTRATION": "true",
    "FORGEJO__server__START_SSH_SERVER": "true",
    "FORGEJO__server__SSH_LISTEN_PORT": "2222",
    "FORGEJO__server__SSH_DOMAIN": listen_ip,
    "FORGEJO__server__SSH_PORT": "2222",
    "FORGEJO__server__ROOT_URL": "http://127.0.0.1:3000/",
    "FORGEJO__database__DB_TYPE": "sqlite3",
}
manifest = {
    "apiVersion": "v1",
    "kind": "List",
    "items": [
        {"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": "videoq-git"}},
        {
            "apiVersion": "apps/v1",
            "kind": "Deployment",
            "metadata": {"name": "forgejo", "namespace": "videoq-git"},
            "spec": {
                "replicas": 1,
                "strategy": {"type": "Recreate"},
                "selector": {"matchLabels": {"app": "forgejo"}},
                "template": {
                    "metadata": {"labels": {"app": "forgejo"}},
                    "spec": {
                        "automountServiceAccountToken": False,
                        "securityContext": {
                            "runAsUser": 1000,
                            "runAsGroup": 1000,
                            "fsGroup": 1000,
                        },
                        "containers": [
                            {
                                "name": "forgejo",
                                "image": "data.forgejo.org/forgejo/forgejo@sha256:5ef02fbcf22beef56b8c844952ffad58cfe177b6f98e46e6abb5df90b88dc8d3",
                                "ports": [
                                    {
                                        "name": "ssh",
                                        "containerPort": 2222,
                                        "hostPort": 2222,
                                        "hostIP": listen_ip,
                                    },
                                    {
                                        "name": "http",
                                        "containerPort": 3000,
                                        "hostPort": 3000,
                                        "hostIP": "127.0.0.1",
                                    },
                                ],
                                "env": [
                                    {"name": k, "value": v} for k, v in env.items()
                                ],
                                "volumeMounts": [
                                    {"name": "data", "mountPath": "/var/lib/gitea"},
                                    {"name": "config", "mountPath": "/etc/gitea"},
                                ],
                                "readinessProbe": {
                                    "httpGet": {"path": "/api/healthz", "port": 3000},
                                    "initialDelaySeconds": 10,
                                    "periodSeconds": 5,
                                },
                                "resources": {
                                    "requests": {"cpu": "100m", "memory": "256Mi"},
                                    "limits": {"memory": "1Gi"},
                                },
                                "securityContext": {"allowPrivilegeEscalation": False},
                            }
                        ],
                        "volumes": [
                            {
                                "name": d,
                                "hostPath": {
                                    "path": str(root / d),
                                    "type": "Directory",
                                },
                            }
                            for d in ["data", "config"]
                        ],
                    },
                },
            },
        },
    ],
}
(root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print("Prepared " + str(root / "manifest.json") + "; no deployment performed")
