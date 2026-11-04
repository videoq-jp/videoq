# Single-server configuration storage assessment

The installer is an operator-side CLI running on the Docker host. It does not
accept configuration or file paths over HTTP. The host, its administrator and
the Docker daemon are trusted; Docker access already permits access to container
environments and persistent volumes.

## Runtime credentials

Docker Compose consumes `runtime.env`, `postgres.env` and `garage.env` as local
plaintext files. Custom TLS keys and cold backups also contain sensitive bytes.
This is intentional runtime credential provisioning, rather than application
logging or a public download. The installer cannot hash these values: services
must use the original database passwords, storage keys and encryption key.

The destination directory is created with mode `0700`. Files are created
exclusively with mode `0600` before any bytes are written, and an existing
installation is never reinitialized. Backups use private directories and files;
restore creates a new private directory and separate volumes. Keep these paths
outside a checkout, web document root and shared logs. Protect backup copies and
use an encrypted host/backup storage system when encryption at rest is required.
This tool does not encrypt backups or protect a host already controlled by an
attacker.

CodeQL `py/clear-text-storage-sensitive-data` reports this intentional local
credential persistence. The assessment applies only to the private installer
configuration writer. It does not justify writing credentials to public files,
HTTP responses, diagnostic output or application logs.

## Non-secret container inputs

The explicit `PUBLIC_FILES` set contains only generated program source and
non-secret routing/infrastructure configuration. These files use mode `0644`
inside the `0700` installation directory so the production containers' different
UIDs can read individual read-only bind mounts. They never include generated
passwords, provider keys, runtime environment files or TLS private keys. Parent
directory traversal still prevents other ordinary host users from opening them.

The two `py/overly-permissive-file` results at these allowlist-only chmod calls
are false positives for secret exposure. Permission changes outside this exact
allowlist, or any secret-bearing additions to the allowlist, require a new review.
No CodeQL rule or path is excluded from scanning.

## Verification

`test_videoq.py` checks private directory/file permissions, exclusive creation,
key preservation on reinitialization, generated configuration and backup path
validation. Docker lifecycle and acceptance tests verify that the non-root
production containers read their inputs and that credentials/data survive
backup, update and restore. Acceptance output captures setup links rather than
printing them in shared logs.
