import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPC_MAX_BATCH_SIZE } from '@videoq/trpc/schema';
import { TRPCClientError } from '@trpc/client';
import { getApiError } from '../api-error';

vi.unmock('@/lib/api');

const { authClientMock } = vi.hoisted(() => {
  const ok = <T,>(data: T = {} as T) => Promise.resolve({ data, error: null });
  return {
    authClientMock: {
      signOut: vi.fn(() => ok()),
      signIn: {
        username: vi.fn(() => ok()),
        social: vi.fn(() => ok()),
      },
      signUp: { email: vi.fn(() => ok()) },
      verifyEmail: vi.fn(() => ok()),
      requestPasswordReset: vi.fn(() => ok()),
      resetPassword: vi.fn(() => ok()),
      changeEmail: vi.fn(() => ok()),
      updateUser: vi.fn(() => ok()),
      oauth2: {
        deleteConsent: vi.fn(() => ok()),
      },
      apiKey: {
        create: vi.fn(() => ok({
          id: '1',
          name: 'integration',
          start: 'vq_123',
          createdAt: '2026-03-02T00:00:00Z',
          key: 'vq_secret',
        })),
        delete: vi.fn(() => ok()),
      },
    },
  };
});

vi.mock('@/lib/auth-client', () => ({
  AUTH_BASE_URL: 'http://localhost:8000',
  authClient: authClientMock,
}));

import { apiPath, createApiClient, type ApiClient } from '../api';
import { createAppTrpcClient, TRPC_UNAUTHORIZED_EVENT } from '../trpc';

const BASE_URL = 'http://localhost:8000/api';

function trpcSuccess(data: unknown): Response {
  return new Response(JSON.stringify([{ result: { data } }]), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function trpcFailure(options: {
  status: number;
  code: string;
  applicationCode?: string;
  message: string;
  details?: unknown;
}): Response {
  return new Response(JSON.stringify([{
    error: {
      message: options.message,
      code: -32000,
      data: {
        code: options.code,
        httpStatus: options.status,
        ...(options.applicationCode ? { applicationCode: options.applicationCode } : {}),
        ...(options.details !== undefined ? { details: options.details } : {}),
      },
    },
  }]), {
    status: options.status,
    headers: { 'content-type': 'application/json' },
  });
}

function rawJson(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('presigned upload content types', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    ['recording.MKV', '', 'video/x-matroska'],
    ['recording.mkv', 'video/matroska', 'video/matroska'],
    ['recording.mkv', 'video/x-matroska', 'video/x-matroska'],
    ['recording.webm', 'application/octet-stream', 'video/webm'],
    ['recording.mov', 'video/quicktime', 'video/quicktime'],
  ])('uses the same MIME type for signing and PUT: %s (%s)', async (name, type, contentType) => {
    vi.stubEnv('VITE_USE_S3_STORAGE', 'true');
    vi.resetModules();
    const { createApiClient } = await import('../api');
    const video = { id: 7, title: 'Video', description: '', file: null, source_type: 'uploaded', status: 'pending', uploaded_at: '2026-09-28T00:00:00Z' };
    const fetchFn = vi.fn().mockResolvedValueOnce(trpcSuccess({ video, upload_url: 'https://objects.example.test/upload' })).mockResolvedValueOnce(trpcSuccess(video));
    const client = createApiClient({ baseUrl: BASE_URL, fetchFn });
    const put = vi.spyOn(client, 'uploadToPresignedUrl').mockResolvedValue();
    const file = new File(['content'], name, { type });
    await expect(client.uploadVideo({ file, title: 'Video', transcriptionLanguage: 'ja' })).resolves.toMatchObject({ id: 7 });
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)['0']).toMatchObject({ filename: name, contentType, fileSize: file.size, transcriptionLanguage: 'ja' });
    expect(put).toHaveBeenCalledExactlyOnceWith('https://objects.example.test/upload', file, contentType, undefined);
    expect(fetchFn.mock.calls[1][0]).toContain('videos.confirmUpload');
  });

  it.each(['ja', undefined] as const)('sends optional language in local upload form (%s)', async transcriptionLanguage => {
    vi.stubEnv('VITE_USE_S3_STORAGE', 'false');
    vi.resetModules();
    const { createApiClient } = await import('../api');
    const video = { id: 7, title: 'Video', description: '', file: null, source_type: 'uploaded', status: 'pending', uploaded_at: '2026-09-28T00:00:00Z' };
    const fetchFn = vi.fn().mockResolvedValue(rawJson(video));
    const client = createApiClient({ baseUrl: BASE_URL, fetchFn });
    await client.uploadVideo({ file: new File(['x'], 'clip.mp4', { type: 'video/mp4' }), title: 'Video', transcriptionLanguage });
    expect((fetchFn.mock.calls[0][1].body as FormData).get('transcriptionLanguage')).toBe(transcriptionLanguage ?? null);
  });

  it('requests multipart for a 45.16 GB video and routes part signing and completion through tRPC', async () => {
    vi.stubEnv('VITE_USE_S3_STORAGE', 'true');
    vi.resetModules();
    const { createApiClient } = await import('../api');
    const transfer = await import('../multipartUpload');
    const video = { id: 7, title: 'Video', description: '', file: null, source_type: 'uploaded', status: 'pending', uploaded_at: '2026-09-28T00:00:00Z' };
    const session = { part_size: 64 * 1024 ** 2, part_count: 673 };
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(trpcSuccess({ video, upload_url: null, multipart: session }))
      .mockResolvedValueOnce(trpcSuccess({ upload_url: 'https://storage.test/part' }))
      .mockResolvedValueOnce(trpcSuccess(video));
    const multipart = vi.spyOn(transfer, 'uploadMultipartFile').mockImplementation(async (_file, _type, _session, operations) => {
      expect(await operations.partUrl(1)).toEqual({ upload_url: 'https://storage.test/part' });
      return operations.complete([{ partNumber: 1, etag: 'a'.repeat(32) }]);
    });
    const client = createApiClient({ baseUrl: BASE_URL, fetchFn });
    const put = vi.spyOn(client, 'uploadToPresignedUrl');
    const file = new File([], 'recording.mkv', { type: 'video/matroska' });
    Object.defineProperty(file, 'size', { value: 45_160_000_000 });
    await expect(client.uploadVideo({ file, title: 'Video', transcriptionLanguage: 'ja' })).resolves.toMatchObject({ id: 7 });
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)['0']).toMatchObject({ multipart: true, fileSize: file.size, transcriptionLanguage: 'ja' });
    expect(multipart).toHaveBeenCalledWith(file, 'video/matroska', session, expect.any(Object), undefined);
    expect(fetchFn.mock.calls[1][0]).toContain('videos.uploadPartUrl');
    expect(fetchFn.mock.calls[2][0]).toContain('videos.completeMultipartUpload');
    expect(put).not.toHaveBeenCalled();
  });

  it('cleans up a failed upload and starts a fresh reservation when the same file is submitted again', async () => {
    vi.stubEnv('VITE_USE_S3_STORAGE', 'true');
    vi.resetModules();
    const { createApiClient } = await import('../api');
    const transfer = await import('../multipartUpload');
    const video = { id: 7, title: 'Video', description: '', file: null, source_type: 'uploaded', status: 'pending', uploaded_at: '2026-09-28T00:00:00Z' };
    const fresh = { ...video, id: 8 };
    const session = { part_size: 64 * 1024 ** 2, part_count: 673 };
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(trpcSuccess({ video, upload_url: null, multipart: session }))
      .mockResolvedValueOnce(trpcSuccess({ message: 'Upload aborted' }))
      .mockResolvedValueOnce(trpcSuccess({ video: fresh, upload_url: null, multipart: session }))
      .mockResolvedValueOnce(trpcSuccess(fresh));
    vi.spyOn(transfer, 'uploadMultipartFile')
      .mockImplementationOnce(async (_file, _type, _session, operations) => {
        await operations.abort();
        throw new Error('Permanent storage failure');
      })
      .mockImplementationOnce(async (_file, _type, _session, operations) =>
        operations.complete([{ partNumber: 1, etag: 'a'.repeat(32) }]));
    const client = createApiClient({ baseUrl: BASE_URL, fetchFn });
    const file = new File([], 'recording.mkv', { type: 'video/matroska' });
    Object.defineProperty(file, 'size', { value: 45_160_000_000 });
    await expect(client.uploadVideo({ file, title: 'Video' })).rejects.toThrow('Permanent storage failure');
    await expect(client.uploadVideo({ file, title: 'Video' })).resolves.toMatchObject({ id: 8 });
    expect(fetchFn.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      '/api/trpc/videos.requestUpload', '/api/trpc/videos.abortUpload',
      '/api/trpc/videos.requestUpload', '/api/trpc/videos.completeMultipartUpload',
    ]);
    expect(JSON.parse(fetchFn.mock.calls[1][1].body)['0']).toEqual({ id: 7 });
    expect(JSON.parse(fetchFn.mock.calls[3][1].body)['0']).toMatchObject({ id: 8 });
  });
});

describe('apiPath', () => {
  it('strips trailing slashes while preserving query strings', () => {
    expect(apiPath('/videos/1/')).toBe('/videos/1');
    expect(apiPath('/chat/messages/?share_slug=abc')).toBe('/chat/messages?share_slug=abc');
    expect(apiPath('/')).toBe('/');
  });
});

describe('ApiClient protocol adapters', () => {
  const fetchMock = vi.fn();
  const originalLocation = window.location;
  let client: ApiClient;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    client = createApiClient({ baseUrl: BASE_URL, fetchFn: fetchMock });
    Object.defineProperty(window, 'location', {
      writable: true,
      value: {
        ...originalLocation,
        origin: 'http://frontend.example.com',
        href: 'http://frontend.example.com/',
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects logout when Better Auth returns an error', async () => {
    authClientMock.signOut.mockResolvedValueOnce({
      data: null, error: { message: 'Session could not be revoked', code: 'SIGN_OUT_FAILED' },
    });
    await expect(client.logout()).rejects.toMatchObject({
      name: 'ApiError', code: 'SIGN_OUT_FAILED', message: 'Session could not be revoked',
    });
  });

  it('rejects logout when the network request fails', async () => {
    const failure = new TypeError('Failed to fetch');
    authClientMock.signOut.mockRejectedValueOnce(failure);
    await expect(client.logout()).rejects.toBe(failure);
  });

  it.each([
    [{ status: true }, true],
    [{ status: true, user: { email: 'new@example.test' } }, false],
  ])('distinguishes email-change approval from completion: %j', async (data, pending) => {
    authClientMock.verifyEmail.mockResolvedValueOnce({ data, error: null });
    await expect(client.confirmEmailChange({ token: 'email-change-token' })).resolves.toEqual({
      requiresNewEmailVerification: pending,
    });
  });

  it.each(['stream', 'csv', 'upload'] as const)(
    'reports a %s 401 without signing out the current session',
    async (protocol) => {
      const onUnauthorized = vi.fn();
      client = createApiClient({ baseUrl: BASE_URL, fetchFn: fetchMock, onUnauthorized });
      fetchMock.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
      const request = protocol === 'stream'
        ? client.chatStream({ messages: [{ role: 'user', content: 'hello' }] }).next()
        : protocol === 'csv'
          ? client.exportChatHistoryCsv(1)
          : client.uploadVideo({ file: new File(['video'], 'video.mp4'), title: 'Video' });

      await expect(request).rejects.toThrow('Authentication failed');
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
      expect(authClientMock.signOut).not.toHaveBeenCalled();
    },
  );

  it('preserves the request authentication error if session revalidation fails', async () => {
    client = createApiClient({
      baseUrl: BASE_URL,
      fetchFn: fetchMock,
      onUnauthorized: async () => { throw new TypeError('Revalidation failed'); },
    });
    fetchMock.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

    await expect(client.exportChatHistoryCsv(1)).rejects.toThrow('Authentication failed');
    expect(authClientMock.signOut).not.toHaveBeenCalled();
  });

  it('uses Better Auth for sign-in, signup, recovery, and profile changes', async () => {
    await client.login({ username: 'user', password: 'pw' });
    await client.loginWithGoogle('/videos');
    await client.signup({ username: 'u', email: 'e@example.com', password: 'p' });
    await client.verifyEmail({ token: 'verify-token' });
    await client.requestPasswordReset({ email: 'e@example.com' });
    await client.confirmPasswordReset({ token: 'reset-token', new_password: 'new' });
    await client.requestEmailChange({ email: 'new@example.com' });
    await client.updateUsername({ username: ' new_name ' });

    expect(authClientMock.signIn.username).toHaveBeenCalledWith({ username: 'user', password: 'pw' });
    expect(authClientMock.signIn.social).toHaveBeenCalledWith({
      provider: 'google', callbackURL: '/videos',
      newUserCallbackURL: '/signup/complete?next=%2Fvideos',
    });
    expect(authClientMock.signUp.email).toHaveBeenCalledWith({
      username: 'u',
      name: 'u',
      email: 'e@example.com',
      password: 'p',
      callbackURL: '/signup/verified?next=%2F',
    });
    expect(authClientMock.requestPasswordReset).toHaveBeenCalledWith({
      email: 'e@example.com',
      redirectTo: 'http://frontend.example.com/reset-password',
    });
    expect(authClientMock.changeEmail).toHaveBeenCalledWith({
      newEmail: 'new@example.com',
      callbackURL: 'http://frontend.example.com/change-email',
    });
    expect(authClientMock.updateUser).toHaveBeenCalledWith({
      username: 'new_name',
      displayUsername: 'new_name',
    });
  });

  it('maps Better Auth failures to ApiError', async () => {
    authClientMock.updateUser.mockResolvedValueOnce({
      data: null,
      error: { message: 'Username is already taken', code: 'USERNAME_IS_ALREADY_TAKEN' },
    });
    await expect(client.updateUsername({ username: 'taken' })).rejects.toMatchObject({
      name: 'ApiError',
      code: 'USERNAME_IS_ALREADY_TAKEN',
    });
  });

  it.each([
    ['integrationApiKeys', {
      id: 'key-105', config_id: 'read-write', name: 'Integration', access_level: 'all',
      prefix: 'vq_preview', last_used_at: null, created_at: '2026-09-01T00:00:00.000Z',
    }],
    ['connectedApps', {
      id: 'grant-105', client_id: 'app', client_name: 'Learning app', scope: 'videoq.read',
      issued_at: null,
    }],
  ] as const)('loads complete %s metadata through one session-authenticated RPC request', async (procedure, row) => {
    const expected = Array.from({ length: 105 }, (_, index) => ({ ...row, id: `${index}` }));
    fetchMock.mockResolvedValueOnce(trpcSuccess(expected));
    const rpc = createAppTrpcClient({ baseUrl: BASE_URL, fetchFn: fetchMock });
    expect(await rpc.account[procedure].query()).toEqual(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain(`/trpc/account.${procedure}?`);
    expect(init.credentials).toBe('include');
  });

  it.each(['integrationApiKeys', 'connectedApps'] as const)('propagates %s failures instead of presenting an empty list', async (procedure) => {
    fetchMock.mockResolvedValueOnce(trpcFailure({ status: 500, code: 'INTERNAL_SERVER_ERROR', message: 'List unavailable' }));
    const rpc = createAppTrpcClient({ baseUrl: BASE_URL, fetchFn: fetchMock });
    await expect(rpc.account[procedure].query()).rejects.toThrow('List unavailable');
  });

  it('uses Better Auth for key creation and integration revocation', async () => {
    expect(await client.createIntegrationApiKey({ name: 'integration', access_level: 'all' }))
      .toMatchObject({ id: '1', api_key: 'vq_secret' });
    await client.revokeIntegrationApiKey(1);
    await client.revokeAuthorizedOAuthToken('consent-1');
    expect(authClientMock.apiKey.delete).toHaveBeenCalledWith({ keyId: '1', configId: 'default' });
    expect(authClientMock.oauth2.deleteConsent).toHaveBeenCalledWith({ id: 'consent-1' });
  });

  it('uses the selected native profile for creation and revocation', async () => {
    await client.createIntegrationApiKey({ name: 'writer', access_level: 'all' });
    expect(authClientMock.apiKey.create).toHaveBeenCalledWith({
      name: 'writer', prefix: 'vq_', configId: 'read-write',
    });
    await client.revokeIntegrationApiKey('native', 'read-write');
    expect(authClientMock.apiKey.delete).toHaveBeenCalledWith({ keyId: 'native', configId: 'read-write' });
  });

  it.each([
    ['test.mp4', 'video/mp4', 'video/mp4'],
    ['test.MKV', '', 'video/x-matroska'],
    ['test.mkv', 'video/matroska', 'video/matroska'],
    ['test.mkv', 'video/x-matroska', 'video/x-matroska'],
    ['test.webm', 'application/octet-stream', 'video/webm'],
  ])('uploads multipart data with the correct file type: %s (%s)', async (name, type, expectedType) => {
    fetchMock.mockResolvedValueOnce(rawJson({
      id: 1,
      file: '/api/media/test.mp4',
      source_type: 'uploaded',
      title: 'Test Video',
      description: 'Desc',
      uploaded_at: '2026-09-06T00:00:00.000Z',
      status: 'pending',
    }, { status: 201 }));
    const file = new File(['content'], name, { type });

    await expect(client.uploadVideo({ file, title: 'Test Video', description: 'Desc' }))
      .resolves.toMatchObject({ id: 1 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/videos`);
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('description')).toBe('Desc');
    const uploadedFile = (init.body as FormData).get('file') as File;
    expect(uploadedFile.name).toBe(name);
    expect(uploadedFile.type).toBe(expectedType);
    expect(uploadedFile.size).toBe(file.size);
  });

  it.each([false, true])('cleans up CSV download resources even if the click fails (%s)', async (clickFails) => {
    const mockLink = document.createElement('a');
    vi.spyOn(mockLink, 'click').mockImplementation(() => {
      if (clickFails) throw new Error('Download blocked');
    });
    global.URL.createObjectURL = vi.fn(() => 'blob:url');
    global.URL.revokeObjectURL = vi.fn();
    vi.spyOn(document, 'createElement').mockReturnValue(mockLink);
    fetchMock.mockResolvedValueOnce(new Response('data', {
      headers: { 'Content-Disposition': 'attachment; filename="chat.csv"' },
    }));

    if (clickFails) await expect(client.exportChatHistoryCsv(1)).rejects.toThrow('Download blocked');
    else await client.exportChatHistoryCsv(1);

    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_URL}/chat/courses/1/history.csv`,
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
    expect(mockLink.download).toBe('chat.csv');
    expect(mockLink.click).toHaveBeenCalled();
    expect(document.body.contains(mockLink)).toBe(false);
    expect(global.URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:url');
  });

  it('resolves relative media URLs and only signs same-origin shared media URLs', () => {
    expect(client.getVideoUrl(null)).toBe('');
    expect(client.getVideoUrl('/api/media/video.mp4'))
      .toBe('http://localhost:8000/api/media/video.mp4');
    expect(client.getVideoUrl('https://cdn.example.com/video.mp4'))
      .toBe('https://cdn.example.com/video.mp4');
    expect(client.getSharedVideoUrl(`${BASE_URL}/media/video.mp4`, 'abc123'))
      .toBe(`${BASE_URL}/media/video.mp4?share_slug=abc123`);
    expect(client.getSharedVideoUrl('https://cdn.example.com/video.mp4?sig=1', 'abc123'))
      .toBe('https://cdn.example.com/video.mp4?sig=1');
  });
});

describe('native tRPC client transport', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
  });

  it('uses the configured API URL, credentials, and inferred procedure path', async () => {
    fetchMock.mockResolvedValueOnce(trpcSuccess({ id: 'u1' }));
    const client = createAppTrpcClient({ baseUrl: BASE_URL, fetchFn: fetchMock });

    await expect(client.account.me.query()).resolves.toEqual({ id: 'u1' });
    const [rawUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(rawUrl)).toContain(`${BASE_URL}/trpc/account.me`);
    expect(init.credentials).toBe('include');
  });

  it('preserves application error codes and details', async () => {
    fetchMock.mockResolvedValueOnce(trpcFailure({
      status: 400,
      code: 'BAD_REQUEST',
      applicationCode: 'VALIDATION_ERROR',
      message: 'name is required',
      details: { name: ['name is required'] },
    }));
    const client = createAppTrpcClient({ baseUrl: BASE_URL, fetchFn: fetchMock });

    const error = await client.account.me.query().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(TRPCClientError);
    expect(getApiError(error)).toEqual(expect.objectContaining({
      name: 'ApiError',
      code: 'VALIDATION_ERROR',
      message: 'name is required',
      details: { name: ['name is required'] },
    }));
  });

  it('calls the configured unauthorized handler on a 401', async () => {
    const onUnauthorized = vi.fn();
    fetchMock.mockResolvedValueOnce(trpcFailure({
      status: 401,
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    }));
    const client = createAppTrpcClient({ baseUrl: BASE_URL, fetchFn: fetchMock, onUnauthorized });

    await expect(client.account.me.query()).rejects.toBeInstanceOf(TRPCClientError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('dispatches an unauthorized event when no handler is configured', async () => {
    const eventHandler = vi.fn();
    window.addEventListener(TRPC_UNAUTHORIZED_EVENT, eventHandler);
    fetchMock.mockResolvedValueOnce(trpcFailure({
      status: 401,
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    }));
    const client = createAppTrpcClient({ baseUrl: BASE_URL, fetchFn: fetchMock });

    await expect(client.account.me.query()).rejects.toBeInstanceOf(TRPCClientError);
    expect(eventHandler).toHaveBeenCalledTimes(1);
    window.removeEventListener(TRPC_UNAUTHORIZED_EVENT, eventHandler);
  });

  it('splits batches at the server maximum', async () => {
    const client = createAppTrpcClient({ baseUrl: BASE_URL, fetchFn: fetchMock });
    fetchMock.mockImplementation(async (rawUrl: string | URL) => {
      const procedures = decodeURIComponent(new URL(String(rawUrl)).pathname.split('/trpc/')[1] ?? '')
        .split(',')
        .filter(Boolean);
      return new Response(JSON.stringify(
        procedures.map(() => ({ result: { data: [] } })),
      ), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await Promise.all(Array.from(
      { length: TRPC_MAX_BATCH_SIZE + 1 },
      () => client.billing.plans.query(),
    ));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const batchSizes = fetchMock.mock.calls.map(([rawUrl]) => (
      decodeURIComponent(new URL(String(rawUrl)).pathname.split('/trpc/')[1] ?? '')
        .split(',')
        .filter(Boolean)
        .length
    )).sort((a, b) => b - a);
    expect(batchSizes).toEqual([TRPC_MAX_BATCH_SIZE, 1]);
  });
});
