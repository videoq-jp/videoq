---
title: Tests and verification commands
description: Choose checks for your change and understand database, browser, and external API prerequisites.
---

# Tests and verification commands

Start with tests close to the changed code. When changing API contracts or the database, also check their consumers. Not all tests run in the same environment.

## Which checks to run

Run these commands from the repository root.

| Changed area | Commands | Prerequisites |
|---|---|---|
| Shared TypeScript contracts | `npm run typecheck` | Dependencies installed with `npm ci` |
| Frontend | `npm run lint` / `npm run test:web` / `npm run build` | Node.js |
| Public-page Worker and landing media | `npm run test:worker --workspace @videoq/web` | `npm run build` first |
| API | `npm run test:api` | Node.js and the Workers test runtime |
| DB schema | `npm run db:check` / `npm run db:verify` | Generated migrations |
| UI interactions and appearance | `npm run test:storybook` / `npm run build:storybook` | Chromium |
| Documentation | `npm run build:docs` | Node.js; builds English and Japanese |

`npm test` runs API and frontend tests. Python and Storybook tests use separate commands.

## Run selected API unit tests

```bash
npm run test:unit --workspace @videoq/api -- test/rag-agent.test.ts
```

The API's regular `test` command runs unit tests followed by Workers runtime tests. To run only the Workers tests:

```bash
npm run test:workers --workspace @videoq/api
```

## Database integration tests

Some tests use real PostgreSQL and pgvector. Tests may be skipped when `QUOTA_TEST_DATABASE_URL` is unset, so passing unit tests alone does not verify database behavior.

```bash
QUOTA_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/postgres npm run test:api
```

This uses the default local connection as an example. **Use a test database only.** Some tests create and clean up databases or schemas, so the connection user also needs permission to create test databases.

## Frontend and Storybook

For example, to check a specific hook:

```bash
npm test --workspace @videoq/web -- src/hooks/__tests__/useTags.test.ts
```

Install Chromium before running Storybook interaction tests:

```bash
npm exec --workspace @videoq/web -- playwright install chromium
npm run test:storybook
```

If you change navigation or parent layouts, also check `src/__tests__/App.navigation.test.tsx` and the `Application/Navigation` story.

## Python worker

Create a dedicated virtual environment with Python 3.12 or later. For these commands only, switch to `apps/worker/`:

```bash
cd apps/worker
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e '.[dev]'
python -m pytest tests/ -q
```

Worker tests that use the database need a test `DATABASE_URL`. Check each test's prerequisites as well.

## Tests using real models

For answer-pipeline changes, start with deterministic tests before opting into model calls:

| Behavior | Focused tests |
|---|---|
| Tool selection, scope, and independent questions | `apps/api/test/rag-agent.test.ts` |
| Structured output, incremental text, and citation boundaries | `apps/api/test/structured-answer.test.ts`, `apps/api/test/answer-content-stream.test.ts` |
| Animation-frame rendering, hidden tabs, completion, and cancellation | `apps/web/src/lib/__tests__/chatStreamController.test.ts` |

Separate from normal CI, a test verifies that a model chooses search tools appropriately:

```bash
RAG_SELECTION_LIVE=1 npm run test:unit --workspace @videoq/api -- test/rag-agent-selection.live.test.ts
```

This connects to a real OpenAI-compatible API and incurs usage charges. It reads `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `LLM_MODEL` from environment variables or the API's `.dev.vars`. It is not required for first-time setup.

**Related:** [Make your first change](../getting-started/first-change.md), [Troubleshooting](troubleshooting.md).

For the paid structured-answer comparison and browser timings, see [cutover and verification](../architecture/structured-answers.md).
