import { createAuthClient } from 'better-auth/react';
import { usernameClient } from 'better-auth/client/plugins';
import { apiKeyClient } from '@better-auth/api-key/client';
import { oauthProviderClient } from '@better-auth/oauth-provider/client';
import { fetchJsonResponse } from './jsonFetch';

const rawApiUrl = import.meta.env.VITE_API_URL || 'http://localhost:8787/api';

/** Origin hosting Better Auth (`/api/auth`). */
const AUTH_BASE_URL = (rawApiUrl.replace(/\/api\/?$/, '') || (globalThis.location?.origin ?? 'http://localhost')).replace(
  /\/+$/,
  '',
);

export const authClient = createAuthClient({
  baseURL: AUTH_BASE_URL,
  basePath: '/api/auth',
  fetchOptions: {
    credentials: 'include',
    customFetchImpl: fetchJsonResponse,
  },
  plugins: [usernameClient(), apiKeyClient(), oauthProviderClient()],
});
