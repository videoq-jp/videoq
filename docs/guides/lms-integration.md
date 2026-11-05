---
title: Connect an LMS with LTI 1.3
description: Enable the optional VideoQ LTI service and connect the separate Moodle plugins.
---

# Connect an LMS with LTI 1.3

VideoQ authenticates learner launches with LTI 1.3 and generates course-scoped
answers. Moodle owns enrollment, source files and playback. Its two plugins,
installers and lab are maintained in
[videoq-moodle](https://github.com/yukiharada1228/videoq-moodle).
Normal VideoQ builds do not require that repository. With `LTI_CONFIG` unset,
the integration endpoints and connection settings remain unavailable.

## Prepare VideoQ

1. Deploy this feature through the normal CI/CD and migration gates. The generated
   `0046_lti_materials` migration adds LTI credentials, installations, courses and
   resource mappings to the normal `main` history through `0045_course_qa`.
   It does not alter existing videos, courses or user records. The earlier
   unreleased lab uses a different migration history; keep that database separate
   rather than treating this migration as its upgrade procedure.
2. Retain the existing S3-compatible signed-upload configuration, processing
   worker/queue and maintenance scheduler. Normal new Moodle connections use
   signed LTI service assertions for discovery, access checks, export and status.
3. Generate an independent tool key outside the checkout:

   ```sh
   node apps/api/scripts/generate-lti-tool-keys.mjs /secure/lti-tool-keys.json
   ```

   The helper refuses overwrites and creates a mode-0600 file. Load its contents
   as the API's `LTI_TOOL_KEYS` secret; never paste it into chat, commit it or
   include it in logs. Retain the current key across releases. During rotation,
   keep the retired **public** key in `previous` while old assertions expire.
4. Set `LTI_CONFIG` to the public HTTPS API origin. For videoq.jp:

   ```json
   { "toolOrigin": "https://videoq.jp", "databaseRegistrations": true, "registrations": [] }
   ```

   On Cloudflare, after the code and DB migration have passed their gates, load
   the configuration and key from private files:

   ```sh
   npx wrangler secret put LTI_CONFIG --config apps/api/wrangler.jsonc --env production < /secure/lti-config.json
   npx wrangler secret put LTI_TOOL_KEYS --config apps/api/wrangler.jsonc --env production < /secure/lti-tool-keys.json
   ```

   Node deployments pass the same two settings through their normal secret
   configuration. Do not reuse the trial key or point production at the trial DB.
5. Check `GET /api/lti/jwks`: it must return a nonempty public RSA key set without
   private components. An LTI login URL without launch parameters is rejected;
   opening it directly is not an end-to-end launch test.

## Connect Moodle

1. Install both plugins using the
   [Moodle setup guide](https://github.com/yukiharada1228/videoq-moodle/blob/main/docs/setup.md).
2. In the owning VideoQ account, open **Settings → Connect Moodle**, enter the
   exact Moodle HTTPS base URL and issue a code. Paste the `VIDEOQ2.` code into
   Moodle's **Connect to VideoQ** page before its ten-minute expiry. Normal setup
   needs no per-connection synchronization API key or per-video JSON.
3. Enable **VideoQ questions** on Moodle File activities. Keep Moodle cron running
   and wait for ordinary export, transcription and indexing.
4. As a permitted learner, launch the course assistant, ask a real question,
   check incremental text and citations, switch videos and test Good/Bad/reset.
   Verify an unenrolled learner cannot access the material.
5. Replace and delete an owned test File, then verify the corresponding VideoQ
   copy changes while unrelated videos and private histories remain intact.

Moodle stores and plays the original; VideoQ stores a processed copy. Every
question rechecks current Moodle access. The custom materials service is
**not a standardized LTI video-sync service**: LTI authenticates launches and
service assertions; the VideoQ/Moodle contract defines export and reconciliation.

## Disconnect and rollout limits

The owner can disconnect a Moodle connection in VideoQ settings. Future launches,
questions and synchronization are denied; existing learning data is retained.
To revoke platform-side trust as well, disable/remove the VideoQ external tool
through Moodle's standard administration. Missing or failed snapshots never
mean that every remote video should be deleted.

Manual static LTI registrations and the legacy push APIs remain operator-only
paths. Avoid duplicate static/database registrations for one issuer/client.
Deep Linking, grade return and roster synchronization are outside this feature.
The tool JWKS endpoint supports signed service authentication; this is not LTI
certification or a claim of compatibility with every LMS.

Before enabling production, check the intended Moodle, theme and browsers. The
[trial review](https://github.com/yukiharada1228/videoq-moodle/blob/v0.10.1/docs/integration-review.md)
records unresolved independent-site chat startup, 100-viewer full-file delivery
and an observed model stream failure. Unit/CI success alone does not resolve
those findings or provide a production capacity or response-time guarantee.
