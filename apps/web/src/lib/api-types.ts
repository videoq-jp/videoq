import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@videoq/trpc';

type RouterInputs = inferRouterInputs<AppRouter>;
type RouterOutputs = inferRouterOutputs<AppRouter>;
export type User = RouterOutputs['account']['me'];
export type AdminUser = RouterOutputs['admin']['getUser'];

type ChatMessage = RouterOutputs['chat']['send'];
export type Citation = ChatMessage['answer']['sources'][number];
export type ChatHistoryItem = RouterOutputs['chat']['history']['data'][number];
export type ChatAnalytics = RouterOutputs['chat']['analytics'];

export type Video = RouterOutputs['videos']['get'];
export type VideoList = RouterOutputs['videos']['list']['data'][number];

export type VideoCourse = RouterOutputs['courses']['get'];
export type VideoInCourse = NonNullable<VideoCourse['videos']>[number];

export type Tag = RouterOutputs['tags']['list']['data'][number];

export type IntegrationApiKey = RouterOutputs['account']['integrationApiKeys'][number];
export type AuthorizedOAuthToken = RouterOutputs['account']['connectedApps'][number];

// Better Auth and raw-transport requests/responses remain explicit.

export interface IntegrationApiKeyCreateRequest {
  name: string;
  access_level: 'all' | 'read_only';
}

export interface IntegrationApiKeyCreateResponse extends IntegrationApiKey {
  api_key: string;
}

export interface SignupRequest {
  username: string;
  email: string;
  password: string;
  callbackURL?: string;
}

export interface VerifyEmailRequest {
  token: string;
}

export interface PasswordResetRequest {
  email: string;
}

export interface PasswordResetConfirmRequest {
  token: string;
  new_password: string;
}

export interface EmailChangeRequest {
  email: string;
}

export interface EmailChangeConfirmRequest {
  token: string;
}

export interface UsernameChangeRequest {
  username: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface ChatRequest {
  messages: RouterInputs['chat']['send']['messages'];
  course_id?: number;
  share_slug?: string;
}

export type { ChatStreamEvent } from '@videoq/trpc/chat';

export interface VideoUploadRequest {
  transcriptionLanguage?: import("@videoq/trpc/video-upload").TranscriptionLanguage;
  file: File;
  title: string;
  description?: string;
}
