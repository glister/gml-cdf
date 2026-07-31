import { createAuthClient } from 'better-auth/react';
import { adminClient, emailOTPClient } from 'better-auth/client/plugins';
import { expoClient } from '@better-auth/expo/client';
import * as SecureStore from 'expo-secure-store';
import { env } from '@/env';

/**
 * Better Auth client for the mobile app. Mirrors the web `auth-client` (admin +
 * email-OTP plugins) and adds the Expo plugin, which persists the session cookie
 * in SecureStore and handles the OAuth/deep-link callback via the app `scheme`.
 *
 * `baseURL` is the API origin; Better Auth appends its default `/api/auth` base
 * path (matching how `apps/api` mounts the handler).
 */
export const authClient = createAuthClient({
  baseURL: env.EXPO_PUBLIC_API_URL,
  plugins: [
    expoClient({
      scheme: 'mobile',
      storagePrefix: 'mobile',
      storage: SecureStore,
    }),
    adminClient(),
    emailOTPClient(),
  ],
});
