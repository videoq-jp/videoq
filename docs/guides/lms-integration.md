---
title: Connect an LMS with LTI 1.3
description: Connect the separate Moodle plugins without registering LTI server settings or signing keys.
---

# Connect an LMS with LTI 1.3

VideoQ authenticates learner launches with LTI 1.3 and generates course-scoped
answers. Moodle owns enrollment, source files and playback. Its two plugins,
installers and lab are maintained in
[videoq-moodle](https://github.com/yukiharada1228/videoq-moodle).
Normal VideoQ builds do not require that repository.

## Connect Moodle

1. Update VideoQ through its ordinary deployment and DB migration gates. The
   existing canonical HTTPS `BETTER_AUTH_URL`, `USER_SECRET_ENCRYPTION_KEY` and
   working S3-compatible storage configuration are used automatically. No
   `LTI_CONFIG` or `LTI_TOOL_KEYS` registration is required.
2. Install both Moodle plugins using the
   [Moodle setup guide](https://github.com/yukiharada1228/videoq-moodle/blob/main/docs/setup.md).
3. As a Moodle administrator, open **Connect to VideoQ** and enter the cloud or
   on-premises VideoQ HTTPS URL. Continue to VideoQ, sign in to the owning account,
   check the displayed Moodle URL and quota permissions, and allow the connection.
   You return to Moodle automatically; no connection-code copying is required.
   Complete this flow within ten minutes. It needs no per-connection API key or
   per-video JSON. The older code-based method remains available under the
   collapsed compatibility section.
4. Enable **VideoQ questions** on Moodle File activities. Keep Moodle cron,
   VideoQ's processing worker/queue and maintenance scheduler running. Wait for
   ordinary export, transcription and indexing.
5. As a permitted learner, launch the course assistant, ask a question, check
   incremental text/citations, switch videos and test Good/Bad/reset. Verify an
   unenrolled learner cannot access the material. Replace/delete an owned test
   File and check that unrelated videos and private histories remain intact.

Hosted VideoQ must be able to reach the Moodle HTTPS endpoints. An SSH-forwarded
localhost trial URL does not make Moodle reachable from the hosted service.
Moodle must also reach the selected VideoQ server. Discovery uses the selected
server's existing API and frontend URL settings, including custom HTTPS ports.
The return destination is fixed to that Moodle's plugin callback. Session state
and S256 proof bind the temporary code to the initiating Moodle administrator;
intercepting the code alone does not authorize an exchange or its retry.

## Automatic signing identity

The first authenticated connection-code request generates an RSA signing key.
The private key is encrypted with the existing application encryption key and
stored in `lti_tool_keys`. Replicas serialize initialization in the same owner
transaction and reuse the stored identity. Anonymous requests and simply opening
the settings page do not generate keys. Public components are available at
`GET /api/lti/jwks` after initialization; before that it returns an empty key set.

Restarts and normal updates retain the key. Database backups include the encrypted
identity; restore them with the same application encryption key. An unreadable or
corrupt existing identity fails closed rather than being silently replaced. Keep
the application's normal encryption key with its secret backups: do not generate
a replacement during an ordinary update.

Generated migrations `0046_lti_materials` and `0047_lti_managed_keys` add only
integration tables to the normal `main` history through `0045_course_qa`.
They do not alter existing videos, courses or user records. The earlier
unreleased lab uses a different migration history; keep that DB separate rather
than treating these migrations as its upgrade procedure.

## Contracts and administrative overrides

Moodle stores and plays the original; VideoQ stores a processed copy. Every
question rechecks current Moodle access. The custom materials service is
**not a standardized LTI video-sync service**: LTI authenticates launches and
service assertions; the VideoQ/Moodle contract defines export and reconciliation.

The owner can disconnect a Moodle connection in VideoQ settings. Future launches,
questions and synchronization are denied; existing learning data is retained.
To revoke platform-side trust as well, disable/remove the VideoQ external tool
through Moodle's standard administration. Missing or failed snapshots never
mean that every remote video should be deleted.

An administrator can opt out with `LTI_CONFIG=false`. Explicit JSON registrations
in `LTI_CONFIG` and an operator-owned `LTI_TOOL_KEYS` ring remain advanced
compatibility overrides; ordinary setup requires neither. Existing overrides
continue to take precedence. The optional `generate-lti-tool-keys.mjs` helper is
for that operator-managed path, not normal installation. Do not duplicate a
platform/client in static configuration and database registrations.

HTTP-only development deployments do not enable automatic LTI. Deep Linking,
grade return and roster synchronization are outside this feature. This is not
LTI certification or compatibility with every LMS.

Before production activation, verify the intended Moodle, theme and browsers.
The [trial review](https://github.com/yukiharada1228/videoq-moodle/blob/v0.10.1/docs/integration-review.md)
records unresolved independent-site chat startup, 100-viewer full-file delivery
and an observed model stream failure. Removing manual configuration does not
resolve those findings or provide a capacity/response-time guarantee.
