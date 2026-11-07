# Installed Moodle and real CPU acceptance

The Moodle integration needs an actual Moodle site before it can test a
Moodle-owned video through local ASR, indexing, chat and native playback. The
installed fixture is a separate required CI job so an unrelated installer or
image scan cannot prevent its evidence from being collected.

This increment installs that Moodle layer. It does **not** establish complete
Moodle + VideoQ + real-AI acceptance. The existing real CPU runner and its 10 GiB
Docker memory minimum are unchanged. The installed-only runner requires 4 GiB
and makes no model downloads or AI calls.

## Reproducible sources

`.github/moodle-cpu/pins.json` fixes the public Moodle and companion repositories
to full commit identities, and PHP/Apache and Caddy images to registry digests.
The source preparer fetches only those public repositories without stored Git
credentials, checks their fetched commits and records archive SHA-256 values.
It refuses nonempty, symlinked or in-checkout output directories.

The test image contains the actual Moodle source and both companion plugins.
All Python orchestration and CI changes are in the backend repository. Moodle's
plugins, runtime, developer tooling and CI remain PHP-only.

## Owned environment

The runner refuses an existing `videoq-onprem-lab` cluster. Its new kind node
attaches only to a fresh labeled Docker network. All public images are cached
before public IPv4/IPv6 traffic and DNS forwarding are blocked. Existing node
firewall and native-image import helpers are reused.

Moodle uses a separate database and `moodle` login with no superuser,
create-database, create-role or RLS-bypass privilege. A parent owner marker, a
0700 data-directory marker, fixed test origins and the installed site's identity
guard every fixture operation. Pre-existing databases and Moodle resources are
rejected. CLI installation and file creation run as Apache's `www-data` account.

Caddy terminates private HTTPS with an internal CA. Only the public root
certificate is copied into Moodle's trust store; peer verification remains
enabled. Startup also installs that certificate at the companion image's explicit
`curl.cainfo` path, readable by Apache after the CLI drops privileges. Updating
only the system CA bundle does not satisfy that PHP setting. CoreDNS maps three
exact test names to the private proxy service while
preserving Kubernetes service resolution and disabled public forwarding. Static
volumes use paths inside the new disposable node, avoiding helper-image downloads
after egress closes. No service uses host networking, NodePort or LoadBalancer.

The installed check creates an ordinary editing teacher, enrolled student and
unenrolled outsider using core APIs, plus a real File activity containing the
public Japanese FLEURS clip. It evaluates actual current capability, enrolment
and activity visibility, including hide/show, suspend/resume and report-capability
prohibition/removal. It checks private HTTPS with certificate verification and
denied public TCP/DNS. It creates no LTI connection, source opt-in, completed
video, transcript, vector or chat answer.

## Running and evidence

The reusable `.github/workflows/moodle-installed.yml` prepares the pinned sources,
builds `videoq-moodle:cpu-acceptance` and invokes:

```sh
python3 .github/scripts/moodle-install-acceptance.py /absolute/fresh/output
```

The host needs kind, kubectl, Docker and FFmpeg. Image labels must match the
reviewed source pins. The CI job is selected for fixture/runtime/source-pin
changes and its selected result is required by `CI Success`.

Only the public source identities, installed result, status diagnostics and
cleanup confirmation are uploaded. Kubeconfig, generated passwords, cookies,
private command logs, database dumps and signing keys are excluded. Cleanup
checks node/network ownership before deleting them. The existing live report
environment is independent of this runner.

## Remaining full-pipeline gate

Attach this installed site to the still-live real CPU rehearsal, with sufficient
combined memory, before its parent removes the cluster. Then prove actual owner
pairing, normal teacher enable/export, current service discovery, real worker
transcription/indexing, fresh learner LTI/native startup and cited playback.
Exercise nonempty personal conversations and positive report counts, then revoke
permissions, hide the File and suspend enrolment against the same sessions.
Standalone resources belonging to the owner must remain inaccessible to LTI
users. Do not populate ready rows or substitute inference to satisfy that gate.

Cloud-only YouTube/provider acceptance, independent-site restoration, restricted
worker profiles, privacy workflows and the wider feature inventory remain
separate requirements in `moodle-feature-access.md`.
