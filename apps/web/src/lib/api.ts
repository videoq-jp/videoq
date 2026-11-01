import { createParser } from 'eventsource-parser';
import { authClient } from './auth-client';
import { getSafeNextPath } from './authRedirect';
import { trackLandingEvent } from './landingAnalytics';
import { API_URL } from './apiConfig';
import { ApiError } from './api-error';
import { createAppTrpcClient, TRPC_UNAUTHORIZED_EVENT } from './trpc';
import { videoSchema } from '@videoq/trpc/schema';
import { chatStreamEventSchema } from '@videoq/trpc/chat';
import { MULTIPART_UPLOAD_THRESHOLD, videoUploadContentType } from '@videoq/trpc/video-upload';
import { uploadMultipartFile } from './multipartUpload';
import i18n from '@/i18n/config';
import type {
  ChatRequest,
  ChatStreamEvent,
  EmailChangeConfirmRequest,
  EmailChangeRequest,
  IntegrationApiKeyCreateRequest,
  IntegrationApiKeyCreateResponse,
  LoginRequest,
  PasswordResetConfirmRequest,
  PasswordResetRequest,
  SignupRequest,
  UsernameChangeRequest,
  VerifyEmailRequest,
  Video,
  VideoUploadRequest,
} from './api-types';

export { API_URL } from './apiConfig';
export { ApiError } from './api-error';
export type * from './api-types';
// VITE_USE_S3_STORAGE=true: 署名 URL 直 PUT（ローカル Garage / 本番 R2）。false: multipart → VIDEO_BUCKET。
const USE_S3_STORAGE = import.meta.env.VITE_USE_S3_STORAGE === 'true';

type ApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const defaultFetch: ApiFetch = (input, init) => (
  init === undefined ? fetch(input) : fetch(input, init)
);

export interface ApiClientOptions {
  baseUrl?: string;
  fetchFn?: ApiFetch;
  onUnauthorized?: () => void | Promise<void>;
}

/** Strip trailing slashes from API paths (except root). Preserves query strings. */
export function apiPath(path: string): string {
  if (!path || path === '/') return path;
  const qIdx = path.indexOf('?');
  if (qIdx === -1) {
    return path.replace(/\/+$/, '') || '/';
  }
  const pathname = path.slice(0, qIdx).replace(/\/+$/, '') || '/';
  return pathname + path.slice(qIdx);
}

/**
 * UI-facing adapter over the inferred tRPC client. Better Auth and
 * protocol-specific transports such as multipart uploads, CSV, and SSE stay explicit.
 */
export class ApiClient {
  private baseUrl: string;
  private fetchFn: ApiFetch;
  private onUnauthorized?: () => void | Promise<void>;
  private rpc: ReturnType<typeof createAppTrpcClient>;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? API_URL).replace(/\/+$/, '');
    this.fetchFn = options.fetchFn ?? defaultFetch;
    this.onUnauthorized = options.onUnauthorized;
    this.rpc = createAppTrpcClient({
      baseUrl: this.baseUrl,
      fetchFn: this.fetchFn,
      onUnauthorized: () => this.notifyUnauthorized(),
    });
  }

  setUnauthorizedHandler(onUnauthorized: ApiClientOptions['onUnauthorized']): void {
    this.onUnauthorized = onUnauthorized;
  }

  async logout(): Promise<void> {
    const { error } = await authClient.signOut();
    if (error) throw new ApiError(error.message || 'Logout failed', error.code || 'LOGOUT_FAILED');
  }

  private async notifyUnauthorized(): Promise<void> {
    try {
      if (this.onUnauthorized) await this.onUnauthorized();
      else if (typeof window !== 'undefined') window.dispatchEvent(new Event(TRPC_UNAUTHORIZED_EVENT));
    } catch {
      // A failed session refresh must not hide the original request error.
    }
  }

  // Common method to build URL
  private buildUrl(endpoint: string): string {
    return `${this.baseUrl}${apiPath(endpoint)}`;
  }

  private async handleError(response: Response): Promise<never> {
    const errorData = (await response.json().catch(() => ({
      detail: response.statusText,
    }))) as unknown;

    if (errorData && typeof errorData === 'object') {
      // Unified error format: { error: { code, message, details?, params?, fields? } }
      const maybeError = (errorData as { error?: unknown }).error;
      if (maybeError && typeof maybeError === 'object') {
        const errorObj = maybeError as {
          code?: string;
          message?: string;
          params?: Record<string, unknown>;
          details?: unknown;
          fields?: Record<string, string[]>;
        };
        if (typeof errorObj.message === 'string') {
          throw new ApiError(
            errorObj.message,
            errorObj.code ?? 'UNKNOWN',
            errorObj.params,
            errorObj.details ?? errorObj.fields,
          );
        }
      }
    }

    throw new ApiError(`HTTP error! status: ${response.status}`, 'UNKNOWN');
  }

  private async handleAuthError(): Promise<never> {
    await this.notifyUnauthorized();
    throw new Error("Authentication failed");
  }

  async signup(data: SignupRequest): Promise<void> {
    const localePrefix = /^\/en(?:\/|$)/.test(window.location.pathname) ? '/en' : '';
    const nextPath = getSafeNextPath(data.callbackURL ?? null) ?? `${localePrefix}/`;
    const { error } = await authClient.signUp.email({
      email: data.email,
      password: data.password,
      name: data.username,
      username: data.username,
      callbackURL: `${localePrefix}/signup/verified?next=${encodeURIComponent(nextPath)}`,
    });
    if (error) throw new ApiError(error.message || 'Signup failed', error.code || 'SIGNUP_FAILED');
  }

  async verifyEmail(data: VerifyEmailRequest): Promise<void> {
    const { error } = await authClient.verifyEmail({ query: { token: data.token } });
    if (error) throw new ApiError(error.message || 'Verification failed', error.code || 'VERIFY_FAILED');
  }

  async login(data: LoginRequest): Promise<void> {
    const { error } = await authClient.signIn.username({
      username: data.username,
      password: data.password,
    });
    if (error) throw new ApiError(error.message || 'Login failed', error.code || 'LOGIN_FAILED');
  }

  /** Redirects to Google OAuth via Better Auth (`signIn.social`). */
  async loginWithGoogle(callbackURL = '/'): Promise<void> {
    const localePrefix = /^\/en(?:\/|$)/.test(window.location.pathname) ? '/en' : '';
    const nextPath = getSafeNextPath(callbackURL) ?? '/';
    trackLandingEvent('google_auth_started');
    const { error } = await authClient.signIn.social({
      provider: 'google',
      callbackURL,
      // Better Auth selects this URL only when it creates a new user. Existing
      // Google users keep the normal callback and never emit a signup event.
      newUserCallbackURL: `${localePrefix}/signup/complete?next=${encodeURIComponent(nextPath)}`,
    });
    if (error) {
      throw new ApiError(error.message || 'Google sign-in failed', error.code || 'GOOGLE_SIGN_IN_FAILED');
    }
  }

  async requestPasswordReset(data: PasswordResetRequest): Promise<void> {
    const { error } = await authClient.requestPasswordReset({
      email: data.email,
      redirectTo: `${window.location.origin}/reset-password`,
    });
    if (error) throw new ApiError(error.message || 'Request failed', error.code || 'RESET_FAILED');
  }

  async confirmPasswordReset(data: PasswordResetConfirmRequest): Promise<void> {
    const { error } = await authClient.resetPassword({
      token: data.token,
      newPassword: data.new_password,
    });
    if (error) throw new ApiError(error.message || 'Reset failed', error.code || 'RESET_FAILED');
  }

  async requestEmailChange(data: EmailChangeRequest): Promise<void> {
    const { error } = await authClient.changeEmail({
      newEmail: data.email,
      callbackURL: `${window.location.origin}/change-email`,
    });
    if (error) throw new ApiError(error.message || 'Email change failed', error.code || 'EMAIL_CHANGE_FAILED');
  }

  /**
   * Updates username via Better Auth `/update-user`.
   * Also sets `displayUsername` so Google-signup accounts stay in sync.
   */
  async updateUsername(data: UsernameChangeRequest): Promise<void> {
    const username = data.username.trim();
    const { error } = await authClient.updateUser({
      username,
      displayUsername: username,
    });
    if (error) {
      throw new ApiError(error.message || 'Username change failed', error.code || 'USERNAME_CHANGE_FAILED');
    }
  }

  /**
   * Completes email change when the verification link lands on the SPA with `?token=`.
   * Prefer BA's `/api/auth/verify-email` link; this covers callback/token handoff cases.
   */
  async confirmEmailChange(data: EmailChangeConfirmRequest): Promise<{ requiresNewEmailVerification: boolean }> {
    const { data: result, error } = await authClient.verifyEmail({
      query: { token: data.token },
    });
    if (error) {
      throw new ApiError(error.message || 'Email change failed', error.code || 'EMAIL_CHANGE_FAILED');
    }
    // Current-address approval sends the next email and returns only status.
    // New-address verification returns the updated user.
    return { requiresNewEmailVerification: !result || !('user' in result) || !result.user };
  }

  async createIntegrationApiKey(
    data: IntegrationApiKeyCreateRequest,
  ): Promise<IntegrationApiKeyCreateResponse> {
    const { data: created, error } = await authClient.apiKey.create({
      name: data.name,
      prefix: 'vq_',
      configId: data.access_level === 'all' ? 'read-write' : 'default',
    });
    if (error || !created) {
      throw new ApiError(error?.message || 'Failed to create key', error?.code || 'API_KEY');
    }
    return {
      id: String(created.id),
      config_id: created.configId ?? 'default',
      name: String(created.name ?? data.name),
      access_level: data.access_level,
      prefix: String(created.start ?? created.prefix ?? 'vq_'),
      last_used_at: null,
      created_at: String(created.createdAt ?? new Date().toISOString()),
      api_key: String(created.key ?? ''),
    };
  }

  async revokeIntegrationApiKey(id: string | number, configId = 'default'): Promise<void> {
    const { error } = await authClient.apiKey.delete({ keyId: String(id), configId });
    if (error) throw new ApiError(error.message || 'Failed to revoke key', error.code || 'API_KEY');
  }

  async revokeAuthorizedOAuthToken(id: number | string): Promise<void> {
    const { error } = await authClient.oauth2.deleteConsent({ id: String(id) });
    if (error) {
      throw new ApiError(error.message || 'Failed to revoke connected app', error.code || 'OAUTH');
    }
  }

  async *chatStream(data: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatStreamEvent> {
    const { share_slug, ...bodyData } = data;
    const params = new URLSearchParams();
    params.set('tool_progress', '1');
    if (share_slug) params.set('share_slug', share_slug);
    const endpoint = `/chat/messages/stream${params.size ? `?${params}` : ''}`;

    const url = this.buildUrl(endpoint);
    const response = await this.fetchFn(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'Accept-Language': i18n.language },
      body: JSON.stringify(bodyData),
      signal,
    });

    if (response.status === 401) {
      await this.handleAuthError();
    }

    if (!response.ok) {
      await this.handleError(response);
      return;
    }

    if (!response.body) {
      yield { type: 'error', code: 'STREAM_INTERRUPTED', message: '' };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const frames: string[] = [];
    const parser = createParser({ onEvent: event => frames.push(event.data) });
    let trailingCarriageReturn = false;
    let lastSegmentIndex = -1;
    const sourceIds = new Set<number>();

    try {
      while (true) {
        const { done, value } = await reader.read();
        const text = decoder.decode(value, { stream: !done });
        if (text) trailingCarriageReturn = text.endsWith('\r');
        parser.feed(text);
        // The parser holds a trailing CR while waiting for a possible LF.
        // Finish that terminator at EOF without inventing a new blank line.
        if (done && trailingCarriageReturn) parser.feed('\n');
        for (const data of frames) {
          let event: ChatStreamEvent;
          try {
            event = chatStreamEventSchema.parse(JSON.parse(data));
            if (event.type === 'source') sourceIds.add(event.source.id);
            if (event.type === 'text_delta') {
              if (event.segmentIndex < lastSegmentIndex || event.segmentIndex > lastSegmentIndex + 1) {
                throw new Error('Non-sequential answer segment');
              }
              lastSegmentIndex = event.segmentIndex;
            }
            if (event.type === 'citation' && (event.segmentIndex !== lastSegmentIndex || !sourceIds.has(event.sourceId))) {
              throw new Error('Unknown citation segment or source');
            }
          } catch {
            // Skipping a bad delta can make a truncated answer look complete.
            yield { type: 'error', code: 'STREAM_INVALID', message: '' };
            return;
          }
          yield event;
          if (event.type === 'done' || event.type === 'error') return;
        }
        frames.length = 0;
        if (done) break;
      }
      // EOF without a terminal event must not look like a saved, complete answer.
      yield { type: 'error', code: 'STREAM_INTERRUPTED', message: '' };
    } finally {
      // Returning early on a terminal SSE event must release the connection too.
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async exportChatHistoryCsv(courseId: number): Promise<void> {
    const url = this.buildUrl(`/chat/courses/${courseId}/history.csv`);

    const response = await this.fetchFn(url, {
      method: 'GET',
      credentials: 'include',
    });
    if (response.status === 401) {
      await this.handleAuthError();
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Failed to export CSV: ${response.statusText}`);
    }

    const blob = await response.blob();
    const disposition = response.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="?([^";]+)"?/i);
    const filename = match?.[1] || `chat_history_course_${courseId}.csv`;

    const link = document.createElement('a');
    const href = window.URL.createObjectURL(blob);
    try {
      link.href = href;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
    } finally {
      link.remove();
      window.URL.revokeObjectURL(href);
    }
  }
  async uploadToPresignedUrl(
    url: string,
    file: File,
    contentType: string,
    onProgress?: (percent: number) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.setRequestHeader('Content-Type', contentType);

      if (onProgress) {
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            onProgress(Math.round((e.loaded / e.total) * 100));
          }
        });
      }

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(new Error(`Upload failed with status ${xhr.status}`));
        }
      });

      xhr.addEventListener('error', () => reject(new Error('Upload failed')));
      xhr.addEventListener('abort', () => reject(new Error('Upload aborted')));

      xhr.send(file);
    });
  }

  async uploadVideo(
    data: VideoUploadRequest,
    onProgress?: (percent: number) => void,
  ): Promise<Video> {
    const contentType = videoUploadContentType(data.file);
    if (!contentType) throw new ApiError('Invalid video file type', 'INVALID_FILE_TYPE');
    if (USE_S3_STORAGE) {
      // 1. Request presigned upload URL
      const { video, upload_url, multipart } = await this.rpc.videos.requestUpload.mutate({
        filename: data.file.name,
        contentType,
        fileSize: data.file.size,
        title: data.title,
        description: data.description,
        transcriptionLanguage: data.transcriptionLanguage,
        ...(data.file.size >= MULTIPART_UPLOAD_THRESHOLD ? { multipart: true } : {}),
      });

      if (multipart) {
        return uploadMultipartFile(data.file, contentType, multipart, {
          partUrl: partNumber => this.rpc.videos.uploadPartUrl.mutate({ id: video.id, partNumber }),
          complete: parts => this.rpc.videos.completeMultipartUpload.mutate({ id: video.id, parts }),
          abort: () => this.rpc.videos.abortUpload.mutate({ id: video.id }),
        }, onProgress);
      }
      if (!upload_url) throw new Error('Upload URL is missing');

      // 2. Upload file directly to R2/S3
      await this.uploadToPresignedUrl(
        upload_url,
        data.file,
        contentType,
        onProgress,
      );

      // 3. Confirm upload
      return this.rpc.videos.confirmUpload.mutate({ id: video.id });
    }

    const formData = new FormData();
    formData.append('file', data.file.slice(0, data.file.size, contentType), data.file.name);
    formData.append('title', data.title);
    formData.append('description', data.description ?? '');
    if (data.transcriptionLanguage) formData.append('transcriptionLanguage', data.transcriptionLanguage);

    const response = await this.fetchFn(this.buildUrl('/videos'), {
      method: 'POST',
      credentials: 'include',
      body: formData,
    });
    if (response.status === 401) await this.handleAuthError();
    if (!response.ok) await this.handleError(response);
    return videoSchema.parse(await response.json());
  }

  // Get video URL (convert relative URLs to absolute URLs using backend origin)
  getVideoUrl(videoFile: string | null): string {
    if (!videoFile) return '';

    // If already absolute URL (http:// or https://), return as-is
    if (videoFile.startsWith('http://') || videoFile.startsWith('https://')) {
      return videoFile;
    }

    // Resolve baseUrl against window.location.origin to get proper backend URL
    // This handles both absolute URLs (http://...) and relative paths (/api)
    const resolvedBase = new URL(this.baseUrl, window.location.origin);

    // For relative URLs
    if (videoFile.startsWith('/')) {
      // videoFile is an absolute path from origin, combine with origin only
      return `${resolvedBase.origin}${videoFile}`;
    }

    // videoFile is a relative path, combine with base URL path to preserve base path segments
    // Remove trailing slash from base pathname if exists to avoid duplicate slashes
    const basePath = resolvedBase.pathname.replace(/\/$/, '');
    return `${resolvedBase.origin}${basePath}/${videoFile}`;
  }

  // Get video URL for shared course (add share_slug as query parameter)
  getSharedVideoUrl(videoFile: string, shareSlug: string): string {
    // First convert to absolute URL using backend origin
    const absoluteUrl = this.getVideoUrl(videoFile);

    // If getVideoUrl returned empty string, return empty string
    if (!absoluteUrl) {
      return '';
    }

    // Then add share_slug parameter ONLY if the URL is served from our API (ProtectedMediaView)
    // S3 presigned URLs (external origin) already contain authentication info in query params,
    // and appending share_slug would invalidate the S3 signature.

    // Check if the video URL shares the same origin with our API
    // We compare with this.baseUrl (which might be relative or absolute)
    try {
      const videoUrlObj = new URL(absoluteUrl);
      const apiBaseUrlObj = new URL(this.baseUrl, window.location.origin);

      // If origins match, it means we are serving the file, so we need the share slug for permission check
      if (videoUrlObj.origin === apiBaseUrlObj.origin) {
        videoUrlObj.searchParams.set('share_slug', shareSlug);
        return videoUrlObj.toString();
      }

      // If origins differ (e.g. S3), do NOT append share_slug
      return absoluteUrl;
    } catch (e) {
      // If URL parsing fails, fallback to original behavior (safer) or return as is
      console.warn('Failed to parse video URL for share slug check', e);
      return absoluteUrl;
    }
  }

}

export function createApiClient(options?: ApiClientOptions): ApiClient {
  return new ApiClient(options);
}

export const apiClient = createApiClient();
