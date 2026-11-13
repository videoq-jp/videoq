---
title: Connect Moodle and other LMS platforms
description: Install the standalone Moodle plugin and connect each teacher to an owned VideoQ course.
---

# Connect Moodle and other LMS platforms

Moodle manages enrollment, current course permissions and the native learning screen. VideoQ stores and processes the linked course videos and provides AI answers. The Moodle integration is maintained in [videoq-moodle](https://github.com/videoq-jp/videoq-moodle). Normal VideoQ builds do not require that repository.

Google Classroom uses the separate [Classroom add-on](google-classroom-integration.md).

## Connect Moodle

1. Use the current cloud service at `https://videoq.jp` or a compatible HTTPS on-premises deployment with teacher-owned connection APIs and DB migrations 0062–0064. Cloud users do not configure server secrets. On-premises operators retain their existing `BETTER_AUTH_URL`, `USER_SECRET_ENCRYPTION_KEY` and S3-compatible storage settings and use the normal deployment/migration procedure.
2. Install **one plugin, local_videoq.zip**, through Moodle's **Install plugins** screen. Version 0.25.4 removes the old helper dependency. Download the ZIP and verification-only SHA256SUMS from the [release](https://github.com/videoq-jp/videoq-moodle/releases/tag/v0.25.4). Follow the [Moodle setup guide](https://github.com/videoq-jp/videoq-moodle/blob/main/docs/setup.md); Git is an optional operator method. The plugin remains a prerelease and has not been approved for the Moodle directory.
3. As the Moodle administrator, open **Connect to VideoQ**, choose the service, sign in and approve communication with this school. Return to Moodle to finish. This grants transport access; it does not assign all courses or allocate learning quota to the installer.
4. As an editing teacher, choose **Connect my VideoQ account** from the Moodle course. Sign into your own VideoQ account, select an existing course you own and confirm. Each Moodle course has an explicit responsible teacher and linked course; co-teachers cannot replace someone else's connection.
5. Add and edit videos in VideoQ. Learners open the course assistant in Moodle, with no VideoQ account registration. Moodle File activities are not imported. Confirm playback, AI questions, citations, video switching, course Q&A and feedback with the intended Moodle/theme/browser.

The learning screen follows the native VideoQ arrangement using Moodle templates and theme styles. Conversations resume automatically. The connected owner teacher can read the latest 100 question logs and export all logs with learner profile information as CSV; students and other co-teachers cannot use those exports. Current Moodle permissions are checked for protected requests.

## Upgrade an existing Moodle installation

Update the VideoQ service first when self-hosting. Update **local_videoq in place** with the new ZIP; do not uninstall the local plugin or delete courses/videos. An already installed `ltisource_videoq` helper does not prevent the update. After checking the native course connection, uninstall only that retired helper using Moodle's plugin overview and remove its code if Moodle cannot do so. Generated VideoQ activity links open the native viewer automatically; a second LTI-helper installer is no longer distributed.

The former installation-wide ownership/import workflow is retired. Teachers reconnect their own accounts and select existing VideoQ courses; ownership is not silently transferred from the installer. Source videos and historical records are preserved during an in-place plugin update. See the [exact update steps](https://github.com/videoq-jp/videoq-moodle/blob/main/docs/setup.md#existing-installations-update-without-losing-courses).

## Transport and signing identity

The selected VideoQ and Moodle services need reachable HTTPS endpoints. An SSH-forwarded localhost trial does not make a local Moodle reachable from hosted VideoQ. If the API has a separate hostname, enter its public origin; discovery opens the configured frontend. Custom HTTPS ports are supported. The return callback is fixed to the initiating Moodle, and administrator session state and S256 proof bind the temporary authorization code.

Moodle uses its core tool registration internally and signs native server requests; users do not install a separate LTI helper or create a manual launch activity. VideoQ manages its encrypted signing identity through its existing integration tables. Retain the established application encryption key across updates and restore database backups with the matching key. Unreadable saved keys fail closed rather than being silently replaced. Ordinary setup does not require manual `LTI_CONFIG` or `LTI_TOOL_KEYS` registration.

Teachers disconnect their individual course connection through VideoQ connected-app settings. A school administrator manages school transport authorization separately. Disconnecting prevents future protected access and retains stored learning data; it is distinct from a privacy erasure request. Grade passback, roster synchronization and general LTI certification are outside this integration.

## Other LMS connectors

Moodle's automatic pairing is provider-specific. An independently operated LMS
connector can use the same native learning, privacy and materials contracts with
its own registered issuer and HTTPS JWKS/OAuth/context endpoints. It must derive
the subject and current enrollment/capabilities from its authenticated LMS session,
sign server requests, and implement material export/reconciliation. A platform that
only supports ordinary LTI launches does not automatically implement these custom
services. Do not use another platform's issuer or signing keys as your connector's
identity.

An operator can provision a service connection for an existing active VideoQ owner
with `apps/api/scripts/provision-lms.ts register-service INPUT.json NEW_OUTPUT.json`
using the deployment's `DATABASE_URL`. Input fields are `id`, `ownerUserId`, `name`,
`issuer`, `clientId`, `deploymentId`, `authorizationUrl`, `jwksUrl` and
`materialsService: { tokenEndpoint, endpoint }`. Authorization and JWKS URLs must
belong to the registered issuer origin. The operator approves all endpoint URLs;
learner requests cannot select them. The command creates its output exclusively
with mode 0600 and returns `{ installationId, mode: "service" }` without a push
credential. Provisioning grants transport access only; an explicit teacher course connection is still required.

The context API implements `courses`, `manifest`, `access`, `export`, `status` and
`ack` as defined by `features/lms/connector-client.ts` and `contracts.ts`. IDs are
opaque strings, not Moodle numbers. The access response supplies current known
capabilities, which VideoQ intersects with its owner, course, resource and generation
bindings. Subjects must retain exactly the same value in learning and privacy
requests. Privacy export/erasure requires separately approved platform recovery
authority; a learner role must never authorize it. See [the native contract and compatibility rules](https://github.com/videoq-jp/videoq/blob/241bd96b81aaf2b5b77de007d7246732433331d4/docs/design/moodle-native-ui.md#shared-connector-boundary).

The independent connector contract tests cover these boundaries with controlled
network responses and real PostgreSQL/signature verification. Live integrations
with other LMS vendors still require their own implementation and acceptance tests.

## Verification

The standalone plugin is tested with Moodle 5.1.8+/Boost, PostgreSQL/MySQL upgrades from 0.25.3, helper removal and a fresh single-plugin reinstall. Installed tests also cover real school authorization, teacher connection, student playback/local AI answers, conversation/feedback restoration and owner-only CSV. See [plugin verification](https://github.com/videoq-jp/videoq-moodle/blob/main/docs/verification.md).

These tests do not establish load capacity for every school, iPhone hardware behavior or compatibility with every LMS vendor. Other LMS connectors need their own implementation and acceptance checks.
