# Infrastructure for K3s on one VPS

These files are internal inputs to `scripts/onprem/k3s.py`, which manages one
Linux VPS running K3s inside Docker through k3d. Follow the
[operator guide](../../../../docs/guides/on-premises-single-server.md)
or its [Japanese translation](../../../../apps/docs/i18n/ja/docusaurus-plugin-content-docs/current/guides/on-premises-single-server.md).
For an existing Kubernetes cluster, use the application Helm chart instead.

- `infrastructure.yaml` defines PostgreSQL, Garage, a persistent queue and the
  HTTPS gateway, plus four separate PVCs. Application workloads belong to Helm.
- `garage.toml` and `elasticmq.conf` are mounted through `videoq-infra-config`.
  The installer generates the Caddyfile from the chosen public URL and stores
  credentials in separate Secrets.

The gateway's internal NodePort is 30443. k3d publishes it on public TCP 443;
the Kubernetes API remains loopback-only. Signed bucket paths share the application
origin. Certificates are retained on the `caddy-data` PVC and media responses
carry a sandbox CSP. There is no SSH trial configuration in these inputs.

Infrastructure images are digest-pinned; keep them aligned with
`scripts/onprem/common.py`. Data-owning Deployments use `Recreate` to avoid
concurrent old/new writers. Never delete PVCs to retry an application rollout.
Deleting the installation with `uninstall --purge` also removes its data and
internal backups; copy needed backups to another host first.
