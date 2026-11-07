# Independent VideoQ account management from Moodle

Course learning uses Moodle authority. Account settings, global library/tag
management, billing, credentials and VideoQ system administration use independent
VideoQ authentication. A Moodle administrator or teacher is not automatically the
owner or administrator of the connected VideoQ account.

The companion adds an account-management link to its administrator connection
page and authorized teacher source controls. `account.php` requires Moodle login
and either site configuration authority or the current course content capability.
It reads the configured LTI registration and asks the approved API origin for
public discovery metadata. The metadata advertises a fixed `/moodle/manage` page,
supporting deployments with different API and web origins. TLS verification stays
enabled, redirects are not followed, response size is bounded and older servers
without this metadata produce a generic local error. Caller-provided destinations
are never accepted.

The handoff contains only the Moodle issuer, client ID and deployment ID. It
contains no Moodle session key, learner identity, pairing code, owner ID or VideoQ
credential. It opens a separate tab with `noopener noreferrer`; the private LTI
iframe and its message bridge do not carry account-management capabilities.

## Independent authority

The web page requests normal VideoQ sign-in, preserving the registration tuple
through the existing same-origin login continuation. The management endpoint at
`POST /api/lms/pairing/management` accepts only that tuple and requires a fresh
Better Auth browser session plus an allowed browser origin. LTI, synchronization,
API-key and OAuth bearer credentials do not substitute for this session. The
endpoint only reads the account and registration; it does not fetch the supplied
issuer, issue credentials or change any entitlement.

The server matches all three registration fields and its independently
authenticated owner ID. Its response contains ownership/activation booleans and
navigation permissions, not another account's identity or private connection
metadata. VideoQ system-administrator navigation comes from the current database
role. A system administrator who does not own the connection gets the system
administration link without being treated as its billing owner.

| Current VideoQ authority | Available navigation |
| --- | --- |
| Anonymous, invalid or expired session | Sign in; no account-management links |
| Signed in, different owner or mismatched registration | Account-switch action; no connected-account settings or billing |
| Exact owner, active or inactive connection | Global videos/tags, independent courses, profile and integrations |
| Exact cloud owner | Plans, billing and existing payment portal as well |
| Independently authenticated VideoQ system administrator | Existing system-administration UI |

Inactive connections and over-quota accounts retain recovery navigation. Opening
settings does not reconnect Moodle or clear quota restrictions. On-premises builds
do not offer cloud billing or unavailable search-key settings. The existing
Stripe, licensing and API authorization rules are unchanged. No navigation link
performs a checkout, password change, credential creation or administrator action.

The page validates its exact query shape and the bounded server response. It
discards ambiguous/extra parameters, hides links while verification is pending or
fails, and keys data by the signed-in identity so late responses from a previous
account do not restore its controls. Switching accounts is an explicit action.
Every destination continues to enforce its own normal VideoQ authorization.

## Scope and release

Deploy the matching API, web page and companion together. The local plugin is
0.15.1 / 2026110608; no database migration or new persistent data is introduced.
This provides an independent operator handoff, including global tag management.
Delegated course-scoped tags/filtering, canonical Moodle uploads/imports/course
management, aggregate reporting, learner privacy workflows and the remaining
live browser/AI acceptance are still tracked in `moodle-feature-access.md`.

## Verification (2026-11-06)

The PostgreSQL LMS integration suite passes all 40 tests, including independent
browser authentication, exact ownership, current administrator-role revocation,
inactive/over-quota recovery, invalid origins and cloud/on-premises navigation.
The web regression run passes 112 tests across nine files, including 22 new page
and query-parser cases. Seven Chromium Storybook cases cover owner, inactive,
other-account, administrator-only, signed-out and mobile presentation using HTTP
fixtures. API/web type checks, changed-source ESLint, Node API builds, cloud and
on-premises web builds, and the on-premises artifact policy check pass.

An isolated Moodle 5.1 instance upgrades the companion to 0.15.1 successfully.
Real verified-TLS HTTP form requests produce the same fixed 303 handoff for a
site administrator and an authorized course teacher. A learner and a teacher
without site configuration authority receive Moodle's 404 denial. Only the three
public registration fields are transferred; caller-supplied destinations are
ignored. The live API, running with the restricted API database role, confirms
the independently signed-in owner, hides on-premises billing/system administration,
hides a mismatched registration, and rejects forged roles, wrong origins and an
LTI credential without a browser session. Source cmid 5 remains at generation 4.

A real macOS Chromium journey through those services also passes without HTTP
mocks: normal Moodle teacher login, `account.php` redirect, independent VideoQ
owner sign-in, owner navigation, the existing integrations destination, a
mismatched registration with no account links, and explicit sign-out with the
registration preserved for the next login. At 390 × 844 the management page has
no horizontal overflow. Billing, system administration and unavailable search-key
navigation stay hidden in the on-premises build. The browser accepts only the
ephemeral local test certificate; separate PHP/API HTTP evidence verifies the lab
CA. This is a backend web test, with no Node tooling added to the companion.
The optional Linux ARM Chromium/PHP harness could not initialize its browser and
does not count as passing evidence.

The companion's 13 PHP contract suites and official Moodle coding check pass
with zero errors or warnings. These checks do not establish complete real-AI
processing, all course operations, billing checkout or external privacy workflows.

Additional owned on-prem browser acceptance on 2026-11-07 verifies a newly
provisioned VideoQ system administrator who does not own the Moodle connection.
The actual single-use password setup and separate Moodle/VideoQ sign-ins
complete without HTTP mocks. Moodle administration alone grants no VideoQ
navigation; the independently authenticated system administrator sees only
system administration, with connected-owner and billing navigation absent.
The real admin UI changes only that fresh actor's quotas, disables self-role and
self-deactivation controls, and the backend rejects a valid self-demotion write.
After an operator revokes only this new actor's role, its original browser
session loses both the admin API and management navigation. The 390px UI has no
horizontal overflow. Both synthetic accounts from the failed and successful
attempts and all their auth/reset rows are independently confirmed absent;
original users/roles, protected source data and all 19 report receipts remain.

The first activation navigation timed out before form interaction. Later
expired-link HTTP and actual browser probes were healthy; no cause or cold-start
correction is established. The harness supports the actual Japanese UI as well
as English, and starts a fresh context after activation to independently prove
the authentication boundary. This does not verify the complete provisioning,
access-reset/deletion/global-reindex lifecycle, cloud billing or full parity.
