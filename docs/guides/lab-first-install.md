---
sidebar_label: Lab setup walkthrough
description: Start with an empty RTX 4090 host and follow the lab installation, acceptance and update workflow.
---

# Lab setup walkthrough

The complete step-by-step manual is currently available in Japanese:

**[Open the Japanese lab installation manual](https://docs.videoq.jp/ja/guides/lab-first-install/).**

Switch this page to **日本語** in the language selector to read the full manual inside this documentation site. It includes commands, expected results, troubleshooting and a handover checklist.

## What the manual covers

1. Prepare a Mac with Python, Ansible, Git and Helm; record the reviewed code revision and host settings.
2. Verify SSH access, the single RTX 4090 and the dedicated Ubuntu host.
3. Bootstrap K3s and Argo CD with Ansible, and store secrets in Ansible Vault.
4. Set up an internal private Forgejo repository and separate read-only and writer deploy keys.
5. Verify a signed public release, compile the site configuration and preserve all four application images locally before pushing configuration.
6. Synchronize the parent, GPU and application Argo CD applications in order.
7. Trust the internal CA, connect directly over the lab LAN or through an SSH SOCKS tunnel, and create the initial administrator.
8. Check a real video upload, transcription, cited answer and playback in the browser.
9. Configure the dedicated test account and fixture, pass the automated smoke test and enable the guarded release follower.
10. Verify retained data after an update, record the handover information and stop an unused rental VM.

No GitHub account, write permission or public deployment-registration PR is required for the lab. Initial downloads and future release discovery require outbound internet access. Internal Git and the Argo CD management API do not require public ingress.

## Scope and operating limits

The workflow is based on manual installation and a real release transition on one rented RTX 4090. The generalized examples have offline contract checks; the new walkthrough has not been replayed on separate lab hardware. A successful smoke test does not replace browser acceptance, capacity planning or an off-host recovery test.

Updates briefly stop writes to take a consistent backup. Argo CD automatic synchronization remains disabled because the host updater controls the backup and synchronization order. OS, GPU drivers, K3s, Argo CD and the Git server require separate maintenance.

The host-local backups and image store are not an off-host disaster-recovery copy. They are not automatically deleted; monitor disk capacity and maintain an encrypted off-host backup policy. Stopping a rental VM stops GPU usage but may still incur storage charges; destroying it deletes its disk.

For detailed operator references, see the [installation runbook](https://github.com/videoq-jp/videoq/blob/main/docs/guides/lab-gitops.md), [automatic update runbook](https://github.com/videoq-jp/videoq/blob/main/docs/guides/lab-auto-update.md) and [reviewable example scripts](https://github.com/videoq-jp/videoq/tree/main/docs/examples/lab).
