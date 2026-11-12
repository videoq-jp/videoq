# Installed Moodle and real CPU acceptance

The required Moodle CI workflow runs the installed-only acceptance fixture.
It tests actual Moodle roles, enrolment, visibility and private HTTPS, requires
4 GiB, and makes no model downloads or AI calls.

The combined Moodle/CPU inference job has been removed from CI because actual
transcription, indexing and chat are too expensive for this integration check.
The combined rehearsal implementation remains available for explicit local use;
it is not a required or scheduled Moodle CI job. The ordinary CPU runner and
signed-release acceptance are independent of this change.

The combined pipeline and run evidence below describe historical verification,
not the current required CI coverage.

At `388e666b`, both required jobs and CI Success pass in run `42362389689`.
The combined job completes all 14 Moodle phases. Both standalone and Moodle ASR
independently reassess to CER 0.0 over 45 reference characters, and protected
playback decodes and seeks correctly. The exact seven-file artifact binds the
source, pinned core/companion, phase results and mobile image. Visual review of
the 390px native page finds no PAGE-context or headers-already-sent warnings;
the companion native-page lifecycle correction is pinned at `20ea7741`.
This establishes the File/local-CPU workflows below, not full parity or release
acceptance.

The mobile tag journey explicitly scrolls the exposed native frame into view
before its ordinary child click, retaining actionability checks and deadlines.
Earlier runs timed out at the first create-tag click after eight phases; their
final frames/buttons were offscreen, but controlled offscreen probes clicked
successfully. Position alone did not establish the failure's cause. No
speculative product/tag fix or forced click was introduced. Failure-only
observations retain bounded visibility, scroll/hit-test state, original catalog
status/counts, fixed Playwright action/navigation signals and passive parent
navigation counts. Raw markup, selectors, credentials, responses and action logs
remain private.

The next acceptance extension adds three runtime-unverified phases. After the
original 14 phases, it creates a second real AI conversation/feedback and a
learner Q&A question with a teacher reply. It uses standard self-service core
export/deletion forms, independent admin UI approval and only each owned
request's actual queued task. The subject downloads the real ZIP; another
teacher credential must be denied. An independent host parser compares all
three model stores' complete exported payloads with private read-only database
snapshots, including checksummed UTF-8 fragment reassembly. Deletion must erase
those stores, invalidate the original subject session, preserve the peer reply
and shared/standalone materials, and refresh reports to zero. Archive contents,
model rows, generated credentials and task logs stay outside public artifacts;
public privacy evidence is independently reconstructed from counts, checksums
and checked booleans.

The installed runner also exercises the API's exact digest-pinned Node/Alpine
base from `apps/api/Dockerfile`, in a separate readonly, unprivileged Pod with no
service-account token. It compares OS and direct DNS resolution with the owned
proxy service, verifies the real TLS peer, loads the Moodle login page and
requires an empty OAuth request to receive 401. It mounts only its public script
and the public CA. Images load before egress closes; no models, API owner login
or valid credentials are involved. The original installed-site evidence is saved
before this added gate, and `node-transport.json` records only booleans, fixed
phase/error labels, numeric statuses and the Node version. This distinguishes
transport failures promptly without waiting for real inference and recovery.
Successful transport does not establish a valid signed OAuth exchange.

At `02d5b549` the actual Node probe fails OS lookup, TLS connection and HTTP with
`EAI_AGAIN`, while a direct A query returns exactly the owned proxy. The fixture
now sets `ndots:1` only on the Node probe and the combined API Pod, preferring the
exact local hostnames before Kubernetes namespace search expansion. It retains
ClusterFirst, generated nameservers/searches, peer verification and blocked
public forwarding. Effective `ndots` is included as a bounded number. At
`f336a533`, Node 26.13.0 records ndots 1, correct OS/direct DNS, verified TLS,
login 200 and empty OAuth 401. The combined job also passes actual signed
Moodle processing and real inference. The prior failed artifact remains the
negative control for this fixture correction.

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

## Historical combined real CPU pipeline

The former second CI job built the actual API/worker/web/Whisper adapter images, verified
capacity before provisioning and invoked `rehearse(..., local_builds=True,
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

The scoped Moodle tick follows the configured transport: LTI snapshots and
acknowledgements come from the real backend material service, with no legacy
push credential. For a transfer it rehydrates the actual queued core task,
preserving negotiated per-user visibility, and executes only the owned source's
job. It does not run general Moodle cron or reconstruct a task with missing data.

A fresh learner context has no owner login cookie. Its signed LTI frame must
become ready, answer the public Japanese question with real local inference,
cite only the managed video, seek and decode the actual Moodle File, save/resume
a nonempty personal conversation and record feedback. A teacher must see
positive UTC report counts and CSV, lose access on the same session after report
capability prohibition, then regain it when restored. Learner reports and forged
standalone transcript IDs are denied. Hiding the source and suspending enrolment
deny the existing learner session and protected media; a teacher with hidden-view
authority remains allowed.

The broader course phase also drives actual tag create/assign/rename/delete,
learner filtering and transcript reading, and denies a learner's tag mutation.
Human Q&A uses normal learner posting and editing plus a teacher reply, reply
editing/deletion, votes and featured-question controls. Learner moderation and
editing the teacher's reply must fail. A real question stays present through
hide/show and suspend/resume: the same learner credential must lose and regain
that question before its author deletes it through the confirmed UI. These
human posts must not increase the one real-AI question in the teacher's report.
These course phases completed in the actual `f336a533` combined run. Its
artifact `13563460393` has SHA-256
`daefab34e27ff811fb111a44c5addc4ff68088aefbadfb523ea97a7d56c01951`.
The exact seven public entries and all 14 phase labels were checked separately
from the CI status. The actual 390px screenshot still exposed the native-page
warnings, so a functional pass alone does not satisfy presentation acceptance.

The browser now rejects Moodle's developer-debugging elements and header-warning
text on both learner and teacher native pages. Debug display remains enabled.
Companion `20ea7741` retains the source activity's core page context and checks
LTI visibility, deletion, capability and course identity without reattaching PAGE
to another activity; the actual LTI launch keeps its own core login. This is a
page lifecycle correction, not a relaxation of source or launch authority.

The native Moodle transcript reader must display and refresh the actual ASR
and seek the real player through a cue button. The teacher's material editor must
save a description, rebuild the real vector index, confirm a transcript clear,
then restore the original ASR through normal UI operations. Actual worker output
must replace the vector row identity on rebuild/restore and remove it on clear,
while retaining ASR checkpoints. The owner's standalone transcript/index must
remain unchanged, and the learner must still receive the original Moodle media
range while the transcript is cleared. Learner material reads and writes are
denied. The ASR quality assessment uses the original real transcript; no ready
state, transcript or vector is inserted as fixture data to meet this requirement.

Personal-history acceptance downloads the actual conversation as NDJSON, checks
its real question/answer/sources and excludes internal/feedback credentials.
A teacher cannot retrieve the learner's conversation UUID. The retained learner
session must lose and regain that conversation with source visibility and
enrolment. Confirmed own deletion must erase its saved turn and all three model
checkpoint stores, refresh the teacher's aggregate counts to zero, and allow a
new empty conversation. Export contents and checkpoint identifiers stay private;
only completed phase labels/counts can be published. This verifies one saved
conversation; approved full-subject privacy requests remain a separate gate.

The browser has a self-signed exception only in its disposable context and routes
requests solely to the three known loopback test origins. PHP/API peer checks
remain enabled with the real CA. A test hook keeps the LTI credential inside its
private frame while issuing real feature-denial requests; no HTTP/AI response is
substituted and no credential is exported in artifacts. Stage labels, public
speech/answer results and a synthetic learner screenshot can be retained;
passwords, raw browser diagnostics, cookies and private runtime state cannot.
Public browser failures include the fixed stage/error category, numeric
line/column in the reviewed acceptance script and a bounded command operation
and exit/signal classification. Moodle CLI exceptions expose only reviewed PHP
class/file labels, fixed error codes and numeric lines. The actual maintenance
CLI uses a test-only Node preload to observe failed requests to the two fixed
Moodle service endpoints. It forwards the original fetch unchanged and never
reads headers or response bodies. Only a fixed service label, HTTP status or
known network error code can enter evidence. Failed maintenance subtasks are
identified by their fixed names; raw errors are reduced to a small enum. The
Python report independently revalidates these values. Messages, selectors,
URLs, SQL, HTTP bodies, credentials and raw stacks remain private.

The `5cbb7505` combined run passed the ordinary CPU lifecycle, including actual
ASR/cited answers, object/database restoration, upgrade/rollback and retention,
then failed during Moodle processing after owner pairing and teacher enable.
Its public artifact identifies only the shared command helper at
`acceptance.mjs:32`. The subsequent `eef6af6f` diagnostics identify backend
maintenance and a rejected fetch to Moodle's OAuth endpoint before any HTTP
response; the underlying network code was not captured. Its standalone ASR
again has CER 0.0 over 45 reference characters. The focused Node probe and
expanded timeout/standard network classifications address that diagnostic gap.
These were failed historical prefixes. The subsequent `02d5b549` negative
control and complete `f336a533` result provide the actual transport correction
and broader functional evidence; they do not prove a warning-free new revision.

Full success requires the combined job, final result and transcript assessment;
a partial browser artifact alone is insufficient. No ready rows, transcripts,
vectors or answer logs are fabricated to satisfy this gate.

Cloud-only YouTube/provider acceptance, independent-site restoration, restricted
worker profiles, privacy workflows and the wider feature inventory remain
separate requirements in `moodle-feature-access.md`.
