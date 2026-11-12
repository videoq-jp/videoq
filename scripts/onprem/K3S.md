# VideoQ single-VPS K3s commands

This installer targets one Linux VPS using k3d to run K3s inside Docker. It is
not a generic Kubernetes provisioner or a native K3s host installer. For existing
clusters use the [Helm guide](../../docs/guides/on-premises.md).

Run from the repository root:

```sh
python3 scripts/onprem/k3s.py install --url https://videoq.example.com
python3 scripts/onprem/k3s.py update
python3 scripts/onprem/k3s.py uninstall
python3 scripts/onprem/k3s.py uninstall --purge
```

Replace the URL with your domain or public IPv4. The installer provisions K3s,
persistent backing services, HTTPS on TCP 443, verified Helm artifacts and the
initial administrator. No SSH forwarding, GitHub login or manual Python package setup is required.
See the [operator guide](../../docs/guides/on-premises-k3s.md)
([Japanese](../../apps/docs/i18n/ja/docusaurus-plugin-content-docs/current/guides/on-premises-k3s.md)).

| Command | Behavior |
|---|---|
| `install` | Install, resume, or reinstall with retained data |
| `update` | Verify a reviewed release, take a cold backup, update Helm and check HTTPS/S3 |
| `uninstall` | Remove application workloads and stop the cluster; retain data, certificates and keys |
| `uninstall --purge` | Delete this installation's cluster and directory, including data, keys and internal backups |

An update selects a successful release and obtains its SHA from GitHub automatically.
`--run-id` and `--source-sha` select an exact reviewed release in automation.
`--backup /private/new-directory` changes the backup location. The default is
`<installation>/backups/<timestamp>`. Backups contain private credentials and
physical PostgreSQL, Garage, queue and certificate data. Copy them off-host and
rehearse restore before relying on them.

An update stops writers and CronJobs before backing up all four PVCs. The manifest
is sealed only after the archive and private configuration files are complete;
checksums are verified before applying migrations. If migration or readiness fails,
application traffic stays stopped. Run `update` again to resume the same target
using the original backup. `install` cannot bypass an unfinished update. There is
no automatic SQL downgrade or restore over changed data.

After ordinary uninstall, `install` starts the retained cluster and reinstalls the
recorded release without regenerating keys. Purge requires typing the cluster name;
`--yes` skips that prompt for automation. It verifies the cluster's storage mount
before deletion and refuses protected filesystem paths. Tool binaries and other
clusters are retained. A backup explicitly stored outside the installation directory
is also retained by purge.

`--directory` selects an installation (default `$HOME/videoq-kubernetes`). Lifecycle
commands require its existing state file and take the same exclusive lock as install.
They do not create a new environment when the directory is wrong. Run `--help` for
all options.

`bash scripts/onprem/install-tools.sh` installs checksum-verified k3d, kubectl, Helm
into `$HOME/.local/bin`; `VIDEOQ_TOOLS_DIR` overrides that location. It also installs Sigstore Python 4.5.1 in a user-owned verification venv. Public Releases and their SLSA bundles are downloaded anonymously; no GitHub CLI, account or token is required.
The root development Compose stack is separate from these Kubernetes commands.
The Compose installer is documented separately in README.md.

## Local inference

`install --ai local-cpu` deploys the signed CPU recipe (llama.cpp for chat/embeddings,
whisper.cpp for speech). `install --ai local-gpu` deploys the signed NVIDIA vLLM
recipe on a previously GPU-enabled k3d cluster. The default is `openrouter`.
No OpenRouter key is requested for local profiles. Matching app/inference profiles
are read from the verified chart archives, not unverified workspace overrides.
CPU supports amd64/arm64; the GPU recipe requires amd64 and three allocatable GPUs.
Drivers, NVIDIA runtime, device plugin and GPU passthrough are operator prerequisites.

The installer checks rendered resource requests before downloading models and
records the chosen profile. It rejects profile changes and embedding-space changes
on existing data. Inference uses a separate Helm release and persistent caches;
normal uninstall retains caches and purge deletes them. Cold update backups omit
redownloadable weights and include inference settings. Public S3 probes run from
the VPS, so application Pods can retain their private-only egress policy.

## Verification

```sh
python3 -m unittest discover -s scripts/onprem -v
```

Run the opt-in test with Docker, k3d, kubectl and Helm available:

```sh
VIDEOQ_K3S_LIFECYCLE=1 python3 -m unittest discover \
  -s scripts/onprem -p test_k3s_lifecycle.py -v
```

It creates a dedicated temporary K3s cluster with no public application ports,
uses real PostgreSQL and PVCs, intentionally fails a migration after changing SQL,
checks that old application workloads remain stopped, resumes the update, verifies
the retained database record and original backup, then exercises both uninstall modes.
Only its own cluster and temporary directory are removed. The fixture release bypass
exists only in the test subclass; the operator CLI has no signature-verification bypass.
Production video/citation/model acceptance remains in the signed release workflow.
