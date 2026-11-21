---
sidebar_label: K3s on one VPS
description: Install VideoQ with one command and serve HTTPS on port 443 from one VPS.
---

# Run VideoQ on one VPS with K3s

This installer targets **one Linux VPS running K3s inside Docker through k3d**.
It is not a general Kubernetes cluster provisioner and does not install native
K3s directly on the host. Use the [Helm guide](on-premises.md) for an existing
Kubernetes cluster.

Run one command to deploy VideoQ on this single-node K3s cluster with Helm.
Web, API, workers, PostgreSQL/pgvector, Garage and a persistent queue all run in Kubernetes. Open the resulting HTTPS URL directly in your browser;
SSH port forwarding is not required.

## Prepare

Use a Linux amd64/arm64 VPS with Docker Engine, Python 3.9+, curl, tar and
coreutils. Run from this repository's root. Reserve resources for K3s as well
as the application; inference defaults to hosted OpenRouter. Single-node storage
has no host-failure redundancy, so keep data and key backups on another host.

Allow inbound **TCP 443** in the VPS provider's firewall and any host firewall.
Keep SSH access available. The installer does not change firewall rules.
Only the HTTPS gateway is published; the Kubernetes API is bound to loopback,
and the database, queue and storage API stay internal to the cluster.

When needed, the installer raises `fs.inotify.max_user_instances` to 1024 so K3s
can coexist with other file watchers. It persists this prerequisite in
`/etc/sysctl.d/90-videoq-k3s.conf`; uninstall does not revert it. An existing file
with different contents is never overwritten.

Choose a public URL:

- With a domain: point its A record at the VPS and use `https://videoq.example.com`.
- Without a domain: use `https://YOUR_PUBLIC_IPV4`. The address must belong to this VPS.

The gateway uses Let's Encrypt's short-lived certificates and TLS-ALPN validation
on port 443, and renews them automatically. Public IPv4 certificates are supported;
there is no need for a self-signed certificate or a browser exception. See the
[Let's Encrypt announcement](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)
and [Caddy issuer options](https://caddyserver.com/docs/caddyfile/directives/tls).
The certificate data is retained on a Kubernetes PVC. Port 80 and UDP 443 are not
required by this configuration.

## Install

Replace the URL with your domain or public IPv4:

```sh
python3 scripts/onprem/k3s.py install --url https://videoq.example.com
```

The command installs missing operator tools in `$HOME/.local/bin`, then performs:

1. Selection of a successful release and signature verification of its images and charts.
2. Creation of a dedicated K3s cluster, or resumption of this installation's cluster.
3. Private credential generation, retaining existing database credentials and encryption keys.
4. Persistent infrastructure, HTTPS gateway and bucket configuration.
5. Helm installation, migrations and the built-in smoke test.
6. Public HTTPS readiness verification and initial administrator provisioning.

The release commit SHA is obtained automatically from the successful GitHub run
and used to verify the signed artifacts; no SHA input is required. It prompts for
an OpenRouter key (without echo) only for hosted AI, and administrator details when needed. GitHub
authentication and Docker permissions must be available; follow any authentication
prompt in the terminal.

Both the application and S3 uploads use the same HTTPS origin on port 443.
The gateway routes `/videoq-media/*` to Garage without rewriting signed paths,
and routes application/API paths to VideoQ. Media responses carry a sandbox CSP
so uploaded documents cannot run scripts on the application origin.

Open the printed single-use administrator setup link, set a password, then
upload a short video. Check transcription, indexing, Q&A and cited playback.
The smoke test alone does not evaluate AI quality or video-processing capacity.

## Choose local AI

Select Whisper, embeddings and LLM together with `--ai` on the initial `install`.
The default is `openrouter`.

```sh
# Local CPU inference
python3 scripts/onprem/k3s.py install --url https://videoq.example.com --ai local-cpu

# Local NVIDIA inference (prepare a GPU-capable cluster first)
python3 scripts/onprem/k3s.py install --url https://videoq.example.com --ai local-gpu
```

| Option | LLM and embeddings | Whisper |
|---|---|---|
| `--ai openrouter` (default) | OpenRouter | OpenRouter |
| `--ai local-cpu` | llama.cpp CPU images | Signed gateway + whisper.cpp CPU image |
| `--ai local-gpu` | Signed NVIDIA vLLM image | Signed gateway + the same NVIDIA vLLM image |

Local profiles do not ask for an OpenRouter key. Inference APIs remain internal;
the command configures application endpoints and model names and disables visual
Q&A for these text models. Profiles come from the verified release charts and
verified image values are applied last. CPU supports amd64/arm64; GPU supports amd64.

Reserve resources for resident models. In the verified recipe, **inference alone**
requests 5.25 CPUs and 7.5 GiB RAM for CPU, or 6.25 CPUs, 24.5 GiB RAM and three
allocatable NVIDIA GPUs for GPU. Application, database and cluster resources are
additional. The installer compares the rendered chart's requests with available
node resources and stops before model downloads if they do not fit. A roughly
4 GB VPS cannot run this CPU profile.

The GPU path requires an existing cluster with NVIDIA drivers, GPU runtime, device
plugin and k3d GPU passthrough configured. It will not create the standard CPU-only
k3d node for this profile. Prepare that cluster with the same name and storage
directory first, with a default runtime / CDI configuration that supports GPU Pods
without adding a per-Pod RuntimeClass to this chart. See [K3s NVIDIA configuration](https://docs.k3s.io/advanced) and
[k3d CUDA setup](https://k3d.io/stable/usage/advanced/cuda/). The installer does not
install GPU drivers or runtimes.

Initial setup downloads images and pinned model weights into persistent caches.
Subsequent `install` / `update` uses the recorded profile. Changing `--ai` for an
existing dataset, or updating embedding weights, quantization or settings, requires
a planned reindex and is rejected by this installer. See [local inference](local-inference.md)
for model and reindex details.

Inference is a separate Helm release named `inference`. Ordinary uninstall removes
its workloads and retains model caches; purge deletes caches too. Update backups
include application data, keys and inference settings, but omit redownloadable model caches.

## Resume and inspect

If installation stops, fix the reported cause and rerun **the same command**.
The installer records the selected release, rechecks its signatures and retains
keys and persistent data. It does not delete the cluster, PVCs or existing accounts.
Do not delete those resources to retry a failed step.

Configuration, private credentials, release artifacts and resume state are stored
under `$HOME/videoq-kubernetes`. `admin-setup.txt` is private and contains the
initial setup result. Keep these files out of Git and shared logs.

```sh
export PATH="$HOME/.local/bin:$PATH"
export KUBECONFIG="$HOME/videoq-kubernetes/kubeconfig"
kubectl -n videoq get deployments,pods,jobs,cronjobs,pvc
kubectl -n videoq logs deployment/videoq-gateway --tail=100
kubectl -n videoq logs deployment/videoq-api --tail=100
helm status videoq -n videoq
```

Older versions could stop with `no matching resources found` before the K3s
node registered. The installer now waits up to 180 seconds for registration and
`Ready`. Rerun the updated installation command after that earlier failure. If
registration continues to fail, inspect the K3s server containerd log for `fsnotify`
or `too many open files`.

If certificate issuance cannot complete, check that TCP 443 is reachable from
the internet and that the public IP or DNS record is correct. Do not disable TLS
verification to finish installation. Keep the gateway running for automatic renewal.

For a particular reviewed release, automation can specify `--run-id` and
`--source-sha`. `--directory`, `--cluster`, `--username` and `--email` are optional;
run `python3 scripts/onprem/k3s.py --help` for all options.

## Update

```sh
python3 scripts/onprem/k3s.py update
```

The command selects a new successful release and obtains its SHA automatically.
Use `--run-id` and `--source-sha` to pin a particular release. Signature verification
completes before the running environment is changed.

The command stops writers and maintenance CronJobs, then takes a cold backup of
all four PVCs (database, objects, queue and certificates), credentials and settings.
The default location is `$HOME/videoq-kubernetes/backups/<timestamp>`; specify a
new location with `--backup /private/new-backup`. After checking the backup's
checksums, it resumes infrastructure, upgrades Helm, applies migrations and checks
public HTTPS/S3. Updating requires downtime.

If migration or readiness fails, application traffic stays stopped and the previous
release record and original backup are retained. Fix the cause and repeat `update`
to resume the same target with the same backup. `install` cannot bypass an unfinished
update. There is no automatic SQL downgrade or restore over changed data.

## Uninstall

To remove the application and stop the cluster while retaining data, keys,
certificates and configuration:

```sh
python3 scripts/onprem/k3s.py uninstall
```

Run `install` later to reinstall the recorded release on the retained cluster and
data. Existing accounts remain available.

To **permanently delete the cluster, data, keys, certificates, configuration and
backups inside the installation directory**:

```sh
python3 scripts/onprem/k3s.py uninstall --purge
```

Type the cluster name to confirm. Automation can pass `--yes` to skip that prompt.
The operation is limited to the installation selected by `--directory`. Other
clusters, operator tools and source code are retained. A backup explicitly stored
outside that directory is retained too. Copy needed backups off-host before purge.

## Operations and other deployment paths

Back up PostgreSQL, object data, queue data, credentials and cluster state to
another host, and rehearse restoration. A Helm rollback does not undo SQL
migrations or restore data. Use `update` for a different release. Changing the public URL requires a planned
migration; `install` resumes the recorded installation.

Use the [existing-cluster Helm guide](on-premises.md) for site-managed clusters,
[local inference](local-inference.md) for private AI, and
[signed releases](on-premises-releases.md) for the distribution policy.
