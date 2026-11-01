# Local Garage storage

Docker Compose uses Garage for local S3 storage. Production continues to use
Cloudflare R2 with the existing bindings and credentials.

Garage is pinned by version and image digest in `docker-compose.yml`. It runs as one node with
`replication_factor = 1`; both object data and metadata persist in `garage_data`.
The `--single-node --default-bucket` startup flags create the local layout, access
key, and bucket. The `garage-init` service applies browser CORS using the worker
image's existing boto3 installation. The API and worker start only after it succeeds.

## Start and inspect

Run from the repository root with `.env` in place:

```bash
docker compose up --build -d
docker compose ps -a garage garage-init
docker compose exec garage /garage status
docker compose exec garage /garage bucket info videoq-media
```

`garage-init` is a one-shot service; exit code 0 means initialization succeeded.
It is safe to run again. A stopped init container is expected.

| Setting | Local value |
|---|---|
| Browser / host endpoint | `http://127.0.0.1:9000` |
| Compose endpoint | `http://garage:3900` |
| S3 region | `garage` |
| Bucket | `videoq-media` |
| Access key | `GK00000000000000000000000000000000` |
| Secret key | 64 zero characters, as shown in `.env.example` |

These credentials are for local development only. S3 is published on loopback;
RPC is container-local, and no admin API or management console is published.
Use the Garage CLI to inspect buckets and keys. Objects are private and browser
access uses signed URLs.

Optional `.env` overrides are `GARAGE_ACCESS_KEY_ID`, `GARAGE_SECRET_ACCESS_KEY`,
`GARAGE_BUCKET`, `GARAGE_RPC_SECRET`, `GARAGE_S3_PORT`, and `GARAGE_CORS_ORIGINS`.
Compose maps the S3 settings to the API and worker's existing `R2_*` variables.
ElasticMQ keeps separate dummy `AWS_*` credentials and region `us-east-1`.
The API uses the browser endpoint for signed URLs and the Compose endpoint for
server-side reads, size checks, and deletion.

For a host-run API, copy `apps/api/.dev.vars.example` and match any custom Garage
credentials, bucket, or port. Leave `R2_S3_INTERNAL_ENDPOINT` unset on the host.
For a host-run worker, use the `R2_*` values shown in
`apps/worker/scripts/run_worker.py`, adjusted to match your overrides.

CORS defaults allow GET, HEAD, and PUT from `http://localhost`,
`http://127.0.0.1`, and both origins on port 3000. After changing origins:

```bash
docker compose up -d --force-recreate garage-init
```

Do not use `docker compose down -v` when you want to keep local data.

## Verify real storage behavior

Start the local stack, then run:

```bash
npm exec --workspace @videoq/api -- playwright install chromium
GARAGE_INTEGRATION=1 npm run test:unit --workspace @videoq/api -- test/garage-storage.integration.test.ts
docker compose exec worker python scripts/check_local_storage.py
```

To use an installed Chrome instead of Playwright's bundled Chromium, add
`PLAYWRIGHT_CHANNEL=chrome`. The suite also verifies multipart uploads, exact
signed part lengths, exposed ETags, and assembled object bytes.

The API integration tests use the real storage adapter and Garage. They check
signed PUT/GET, CORS, private objects, HEAD, ranges, ETag conditions, encoded object
keys, and deletion. Chromium uploads a video from the local website's origin,
then plays and seeks it. The worker check uploads bytes and a 10 MiB file,
downloads through boto3, verifies content and metadata, and deletes its test objects.
Both checks use unique `garage-smoke/` keys and clean them up. They do not call AI
services or modify application records. The API tests are skipped unless explicitly
enabled and require the local website at `http://localhost`.

Restart Garage and rerun the checks to verify persistence and reconnection:

```bash
docker compose restart garage
docker compose up -d garage-init
```

## Migrate an existing local MinIO stack

Keep the old `videoq-minio` container attached to the project's network until copying
finishes. The migration helper reads it at `http://minio:9000`. If you customized
`MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, or `MINIO_BUCKET`, retain those values in
`.env` for this migration. They are used only by the optional migration helper.

Stop all writers, including host-run API/worker processes and active browser uploads.
For the Compose services:

```bash
docker compose stop api worker
# Keep MinIO on port 9000 while Garage temporarily uses port 9002.
GARAGE_S3_PORT=9002 docker compose up --build -d garage garage-init
# Wait until garage-init exits with code 0 before copying.
docker compose ps -a garage garage-init
GARAGE_S3_PORT=9002 docker compose run --rm --no-deps garage-migrate
```

The helper copies every object through S3, preserves keys and content metadata,
and verifies SHA-256 after upload. It never deletes source data or overwrites
conflicting destination objects. Repeating it skips objects only after confirming
their content and metadata match. It fails if the source inventory changes during
copying; keep writers stopped until cutover.

After the helper reports that every object is verified:

```bash
docker stop videoq-minio
docker compose up -d garage garage-init
docker compose up -d api worker
```

Garage now serves port 9000. Reopen the app to obtain signed URLs with the new key
and region. Run the verification commands above and check an existing video.
Keep the stopped MinIO container and its `videoq_minio_data` volume as a backup
until you no longer need them. Their on-disk format cannot be mounted as Garage data.
Avoid `--remove-orphans` during migration because the old MinIO services are orphans
in the updated Compose configuration.

Reference: [Garage's official single-node quick start](https://garagehq.deuxfleurs.fr/documentation/quick-start/).
