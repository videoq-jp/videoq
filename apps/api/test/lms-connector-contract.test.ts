import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import type { Bindings } from '../src/types/bindings';
import type { LtiRegistration } from '../src/features/lti/config';
import { courseAccessContext } from '../src/features/lti/course-access';
import { toolJwks } from '../src/features/lti/tool-keys';
import { nativeAssertionClaims } from '../src/features/lms/native-auth';
import { privacyRequest } from '../src/features/lms/privacy-data';
import { resourceManifestSchema } from '../src/features/lms/resource';
import { exportStatusSchema } from '../src/features/lms/connector-client';
import { provisionServiceInstallationSchema } from '../src/features/lms/installation';
import { materialStateKey } from '../src/features/lms/material-state-key';
import { digest } from '../src/features/lti/store';

const subject = '8f11307b-c408-4d9f-a361-7b4418af1970';
const contextId = 'urn:external-course:mathematics/2026';
const resourceLinkId = 'activity/60aa53f8-8a09-4eb1-b057-9d392d637561';
const reg: LtiRegistration = {
  id: 'db:independent-connector', issuer: 'https://connector.example', clientId: 'connector-client', deploymentId: 'tenant:west',
  authorizationUrl: 'https://connector.example/sign-in', jwksUrl: 'https://connector.example/public-keys',
  frameOrigins: ['https://connector.example'],
  materialsService: { tokenEndpoint: 'https://connector.example/oauth/v2/token', endpoint: 'https://connector.example/api/context' },
  resources: [
    { kind: 'course', deploymentId: 'tenant:west', contextId, resourceLinkId: 'course-entry', courseId: 12, generation: 1 },
    { deploymentId: 'tenant:west', contextId, resourceLinkId, courseId: 12, videoId: 3, generation: 1 },
  ],
};
const grant = { deploymentId: 'tenant:west', contextId, resourceLinkId: 'course-entry', courseId: 12,
  resourceGeneration: 1, serviceSubject: subject };
let env: Bindings;
let canManage: boolean;
let responseContext: string;
const requests: { url: string; subject?: string }[] = [];

beforeAll(async () => {
  const keys = await generateKeyPair('RS256', { extractable: true });
  env = { LTI_TOOL_KEYS: JSON.stringify({ current: await exportJWK(keys.privateKey), previous: [] }) } as Bindings;
});
beforeEach(() => {
  canManage = true; responseContext = contextId; requests.length = 0;
  // Controlled connector boundary, not a claim of live support for any named LMS.
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const address = url instanceof Request ? url.url : url.toString();
    requests.push({ url: address });
    if (address === reg.materialsService!.tokenEndpoint) {
      const body = init?.body;
      if (!(body instanceof URLSearchParams) && typeof body !== 'string') throw new Error('Expected an OAuth form');
      const form = new URLSearchParams(body);
      await jwtVerify(form.get('client_assertion')!, createLocalJWKSet(await toolJwks(env)), {
        algorithms: ['RS256'], audience: reg.materialsService!.tokenEndpoint,
      });
      return Response.json({ access_token: 'controlled-connector-token', token_type: 'Bearer',
        expires_in: 60, scope: 'https://videoq.org/spec/lti-materials/v1' });
    }
    if (address !== reg.materialsService!.endpoint) throw new Error('Unexpected connector URL');
    if (typeof init?.body !== 'string') throw new Error('Expected a serialized connector request');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer controlled-connector-token');
    const input = JSON.parse(init.body); requests.at(-1)!.subject = input.subject;
    expect(input.action).toBe('access'); expect(input.subject).toBe(subject);
    return Response.json({ contextId: responseContext, resourceLinkId: 'course-entry', courseEntry: { generation: 1 },
      permissions: { manageContent: canManage, viewQa: true, manageOwnHistory: true, systemAdmin: true },
      resources: [
        { externalId: 'file:opaque/ID', resourceLinkId, lesson: 'External lesson / A', title: 'External lesson',
          generation: 1, management: { generation: 1 } },
        { externalId: 'foreign:resource', resourceLinkId: 'not-registered', lesson: 'foreign', title: 'Foreign material', generation: 1 },
      ] });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('Provider-neutral connector contract', () => {
  it('uses approved connector endpoints, real client assertions and opaque external identities', async () => {
    const access = await courseAccessContext(reg, grant, env);
    expect(access?.videos).toEqual([{ videoId: 3, lesson: 'External lesson / A', title: 'External lesson', management: { generation: 1 } }]);
    expect(access?.permissions.manageContent).toBe(true);
    expect(access?.permissions).not.toHaveProperty('systemAdmin');
    expect(requests.map(r => r.url)).toEqual([reg.materialsService!.tokenEndpoint, reg.materialsService!.endpoint]);
    expect(requests.at(-1)!.subject).toBe(subject);
  });

  it('refreshes permissions on the next request and never derives grants from a role label', async () => {
    expect((await courseAccessContext(reg, grant, env))?.managementVideos).toHaveLength(1);
    canManage = false;
    const access = await courseAccessContext(reg, grant, env);
    expect(access?.permissions.manageContent).toBe(false);
    expect(access?.managementVideos).toBeUndefined();
  });

  it('rejects a different course response and a mismatched deployment', async () => {
    responseContext = 'another-tenant-course';
    await expect(courseAccessContext(reg, grant, env)).rejects.toThrow('Wrong LTI access context');
    await expect(courseAccessContext(reg, { ...grant, deploymentId: 'tenant:east' }, env)).rejects.toThrow('LMS service access required');
  });

  it('fails closed when the connector becomes unavailable', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 503 }));
    await expect(courseAccessContext(reg, grant, env)).rejects.toThrow();
  });

  it('preserves the exact same opaque subject in native and privacy contracts', () => {
    const now = Math.floor(Date.now() / 1000);
    const claims = nativeAssertionClaims.parse({ iss: reg.issuer, sub: reg.clientId,
      aud: 'https://videoq.example/api/lms/native/materials', deploymentId: grant.deploymentId,
      subject, contextId, resourceLinkId, sessionId: 'b'.repeat(64), sessionStartedAt: now - 5,
      sessionExpiresAt: now + 3500, bodySha256: 'a'.repeat(64), locale: 'en', version: 1,
      iat: now, exp: now + 60, jti: crypto.randomUUID() });
    expect(privacyRequest.parse({ action: 'contexts', subject: claims.subject })).toMatchObject({ subject });
    expect(privacyRequest.parse({ action: 'contexts', subject: 'User/CaseSensitive' })).toMatchObject({ subject: 'User/CaseSensitive' });
    expect(privacyRequest.safeParse({ action: 'contexts', subject: '' }).success).toBe(false);
    expect(privacyRequest.safeParse({ action: 'contexts', subject: 'x'.repeat(256) }).success).toBe(false);
  });

  it('accepts generic service provisioning, SHA-256 revisions and opaque export job IDs', () => {
    const setup = provisionServiceInstallationSchema.parse({ id: 'connector:west', ownerUserId: 'owner', name: 'External LMS',
      issuer: reg.issuer, clientId: reg.clientId, deploymentId: reg.deploymentId,
      authorizationUrl: reg.authorizationUrl, jwksUrl: reg.jwksUrl, materialsService: reg.materialsService });
    expect(setup.materialsService.endpoint).toBe(reg.materialsService!.endpoint);
    for (const length of [40, 64]) {
      expect(resourceManifestSchema.parse({ contextId, resourceLinkId, generation: 1, enabled: true, title: 'Lesson',
        file: { filename: 'lesson.mp4', contentType: 'video/mp4', size: 10, contentHash: 'a'.repeat(length) } }).file?.contentHash).toHaveLength(length);
    }
    expect(exportStatusSchema.parse({ jobId: 'queue/job:2026#5', generation: 1, status: 'queued' }).jobId).toBe('queue/job:2026#5');
  });

  it('keeps deployed synchronization keys while separating delimiter-containing identities', async () => {
    expect(await materialStateKey('lti-export:', 'school', '42', 1)).toBe(await digest('lti-export:school:42:1'));
    expect(await materialStateKey('lti-export:', 'school.example', '42', 1)).toBe(await digest('lti-export:school.example:42:1'));
    expect(await materialStateKey('lti-export:', 'tenant:a', 'file', 1))
      .not.toBe(await materialStateKey('lti-export:', 'tenant', 'a:file', 1));
  });
});
