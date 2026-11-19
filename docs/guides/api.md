---
title: Change the API
description: Trace changes from tRPC inputs and outputs through Hono handlers, services, and the database.
---

# Change the API

Start changes to regular JSON APIs in the shared contracts in `packages/trpc`. Hono handles HTTP requests and connects them to the API's implementation handlers.

This project uses **tRPC**, separately from the `hc` RPC client described in Hono's documentation. The endpoint is `/api/trpc`.

## Run the API while editing

Start the [development environment](../getting-started/local-setup.md). The Compose API mounts the source code, and Wrangler's development server reloads changes. Check request results alongside the logs:

```bash
docker compose logs -f api
```

Rebuild the API image as needed after changing dependencies or Docker configuration.

## Example: follow tag creation inputs

`packages/trpc/src/inputs/tags.ts` defines tag creation inputs as follows:

```ts
"tags.create": z.object({
  name: z.string().min(1).max(50),
  color: tagColorSchema.default("gray"),
}),
```

This is an excerpt of the existing definition. `name` must contain 1–50 characters, and the color defaults to `gray`. Validation and defaults are defined here.

## Order of changes

1. **Define inputs.** Set accepted values, constraints, and defaults in `packages/trpc/src/inputs/`.
2. **Define outputs.** Check the response shape in `outputs.ts` / `model-schemas.ts`.
3. **Register the operation.** Choose a query or mutation and its authentication requirements in `routers/`.
4. **Connect the API.** Pass inputs and the user ID to the service in `apps/api/src/trpc/handlers/`.
5. **Implement business logic.** Coordinate operations in `features/<feature>/service.ts` and put DB access in `repositories/`.
6. **Update UI callers.** Change related hooks and components, and verify that refreshed results appear after updates.

When adding an operation or domain, also check shared router aggregation and handler registration in `trpc/context.ts`. The [tag list walkthrough](../getting-started/codebase.md) is a useful starting point.

## Where to check permissions

`protectedProcedure` checks login status, but does not by itself guarantee ownership of a video or tag. Follow the existing implementation: pass the user ID to services and repositories and restrict query scope.

Test valid and invalid inputs, unauthenticated access, another user's data, and nonexistent IDs. See [authentication and access control](../concepts/auth.md).

## When to use Hono routes

Authentication, MCP, Stripe webhooks, video binaries, multipart uploads, chat SSE, and CSV exports use formats other than regular JSON calls. These are assembled in `features/*/routes.ts` and `app.ts`.

For ordinary list, fetch, or update operations, check the existing tRPC routers first.

Chat SSE uses the shared `chatCourseIdSchema` for `course_id`, as tRPC does for
`courseId`: a positive JSON integer, `null`, or an omitted field. Invalid values
are rejected before answer generation and usage reservation.

## Large video uploads

With S3 storage enabled, the web client requests multipart upload for files at
least 100 MiB. Smaller files retain the single PUT path. Account upload and
storage quotas apply before either path reserves a video.

1. `videos.requestUpload` accepts `multipart: true` and returns the video plus
   `multipart.part_size` and `multipart.part_count` (and a null `upload_url`).
2. `videos.uploadPartUrl` accepts the video ID and part number. It checks ownership
   and upload state, signs the exact expected length, and refreshes upload activity.
3. The browser sends at most three parts concurrently, using `File.slice`. Parts
   normally contain 64 MiB; larger objects use larger parts to stay below 10,000.
   Each retry obtains a fresh URL. R2 CORS must expose `ETag` to the browser.
4. `videos.completeMultipartUpload` accepts the numbered ETags, assembles the
   object, verifies its size, and queues transcription once. Completion retries
   recover from a lost storage response or a failed database transaction.
5. `videos.abortUpload` deletes only an unconfirmed upload. Durable cleanup aborts
   its multipart session, deletes stored data, and returns reserved capacity.

The single PUT ceiling is 5 GiB; multipart supports up to 5 TiB subject to the
account quota. See [R2 upload limits](https://developers.cloudflare.com/r2/objects/upload-objects/).
Part URLs expire after one hour and are issued just before each transfer. An
upload becomes abandoned after two hours without a part URL request; active
transfers can run longer than two hours. Failed parts are retried up to three
times. Closing or reloading the page requires starting a new upload; abandoned
data is recovered by the maintenance task.

Deploy migration `0030_multipart_upload_sessions` before the API/worker, followed
by the web client. The existing production CORS configuration exposes `ETag`.
Production uses the R2 binding for create/complete/abort; local Garage uses its
S3 API. No video payload passes through the API Worker.

The Python worker reads uploaded media directly from object storage using HTTP
ranges for audio extraction and visual caches, so it does not need temporary
disk space equal to the source file size. Existing media processing and Lambda
time limits still apply; the storage limit is not a processing-duration guarantee.

## MCP tool inputs

`apps/api/src/tools/management.ts` defines the strict input schemas shared by MCP
registration and tool execution. IDs, byte sizes, and pagination values accept
integers or decimal digit strings such as `42` and `"42"`, within each field's
limits. Booleans, arrays, hexadecimal/exponent strings, and undeclared fields
are rejected before resource access. Pagination defaults belong to the schemas;
handlers consume validated, typed arguments without further coercion or clamping.

## Verify

```bash
npm run typecheck
npm run test:api
```

`typecheck` also detects contract mismatches in the frontend. API tests include Node.js unit tests and Workers runtime tests. DB integration tests require a separate test database. See [tests and verification commands](testing.md) for prerequisites.

**Related:** [tRPC API design](../architecture/trpc-api.md), [Change the database](database.md).
