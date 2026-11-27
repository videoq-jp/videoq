import { expect, it } from 'vitest';
import { Hono } from 'hono';
import { mountLtiManagement } from '../src/features/lti/management-routes';
import type { LearningOperationAccess } from '../src/features/lti/operation-policy';
import type { AppEnv } from '../src/types/bindings';

it.each(['description', 'transcript'])('returns HTTP 400 for NUL %s before opening persistence', async field => {
  const app = new Hono<AppEnv>();
  // Authorization succeeds; no DB binding is supplied, so a persistence call would fail.
  const access = { reg: { id: 'db:school' }, current: { permissions: { manageContent: true } }, grant: {} } as LearningOperationAccess;
  mountLtiManagement(app, async () => access);
  const response = await app.request('/management', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'update', videoId: 1, operationId: crypto.randomUUID(), revision: 'a'.repeat(64),
      fields: { [field]: 'bad' + String.fromCharCode(0) + 'text' } }) });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
});
