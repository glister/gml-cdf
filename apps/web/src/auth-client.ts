import { createIsomorphicFn } from '@tanstack/react-start';
import { createAuthClient } from 'better-auth/react';
import { adminClient, emailOTPClient } from 'better-auth/client/plugins';
import { clientEnv } from './env.client.js';
import { getServerApiUrl } from './env.server.js';

// Browser → VITE_API_URL; SSR → internal API URL. createIsomorphicFn keeps the
// server-only env read out of the client bundle.
const getBaseUrl = createIsomorphicFn()
  .client(() => clientEnv.VITE_API_URL)
  .server(() => getServerApiUrl());

export const authClient = createAuthClient({
  baseURL: getBaseUrl(),
  plugins: [adminClient(), emailOTPClient()],
});
