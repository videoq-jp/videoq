# Installed Moodle and real CPU acceptance

The Moodle integration needs an actual Moodle site before it can test a
Moodle-owned video through local ASR, indexing, chat and native playback. The
installed fixture is a separate required CI job so an unrelated installer or
image scan cannot prevent its evidence from being collected.

There are two required jobs. The installed-only runner requires 4 GiB and makes
no model downloads or AI calls. The combined job calls the existing real CPU
rehearsal with a pinned Moodle image, keeps its baseline lifecycle checks, then
runs Moodle in that same owned cluster before cleanup. Combined acceptance
requires 12 GiB. The ordinary CPU runner retains its 10 GiB minimum, and the
signed-release CLI does not accept the test-only Moodle image.

The installed-only job passed 115 checks at `e9c94ecf`. The combined pipeline is
implemented but remains unproven until its actual CI run passes. Neither unit
tests nor the installed-only result establish complete Moodle + real-AI behavior.

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

## Combined real CPU pipeline

The second job builds the actual API/worker/web/Whisper adapter images, verifies
capacity before provisioning and invokes `rehearse(..., local_builds=True,
moodle_image='videoq-moodle:cpu-acceptance')`. Public model/image downloads finish
before the existing node firewall is installed. Real transcription timestamp/CER,
cited chat, playback, backup/restore, upgrade/rollback and retention checks run
before the new Moodle phase.

The Moodle phase mounts its public CA in the readonly API container and updates
only the owned app's public/storage origins, preserving its CPU model settings.
It connects via the actual administrator/VideoQ-owner approval UI, closes that
browser context, then enables the File as an ordinary teacher. Scoped Moodle
export and the actual backend maintenance command drive processing; SQL only
reads evidence from the parent's restored application database. Checkpoints and
vectors must be nonempty in the configured embedding table, and the new managed
video/course must differ from the owner's standalone sentinel.

A fresh learner context has no owner login cookie. Its signed LTI frame must
become ready, answer the public Japanese question with real local inference,
cite only the managed video, seek and decode the actual Moodle File, save/resume
a nonempty personal conversation and record feedback. A teacher must see
positive UTC report counts and CSV, lose access on the same session after report
capability prohibition, then regain it when restored. Learner reports and forged
standalone transcript IDs are denied. Hiding the source and suspending enrolment
deny the existing learner session and protected media; a teacher with hidden-view
authority remains allowed.

The browser has a self-signed exception only in its disposable context and routes
requests solely to the three known loopback test origins. PHP/API peer checks
remain enabled with the real CA. A test hook keeps the LTI credential inside its
private frame while issuing real feature-denial requests; no HTTP/AI response is
substituted and no credential is exported in artifacts. Stage labels, public
speech/answer results and a synthetic learner screenshot can be retained;
passwords, raw browser diagnostics, cookies and private runtime state cannot.
Public browser failures include only the fixed stage/error category and numeric
line/column in the reviewed acceptance script. Messages, selectors, URLs, HTTP
bodies and raw stacks remain private.

Full success requires the combined job, final result and transcript assessment;
a partial browser artifact alone is insufficient. No ready rows, transcripts,
vectors or answer logs are fabricated to satisfy this gate.

Cloud-only YouTube/provider acceptance, independent-site restoration, restricted
worker profiles, privacy workflows and the wider feature inventory remain
separate requirements in `moodle-feature-access.md`.
