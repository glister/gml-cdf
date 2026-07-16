import { betterAuth } from 'better-auth';
import { admin, customSession, emailOTP } from 'better-auth/plugins';
import { pool } from '@repo/db';
import { createEmailClient } from '@repo/email';
import { parse, z } from '@repo/env';
import { logger } from '../logger.js';

/**
 * Better Auth instance. Email/password + email OTP + admin (roles admin/agent).
 * Backed by the shared Postgres pool from `@repo/db`. Our DB columns are
 * snake_case, so every model (and the admin-plugin fields) maps Better Auth's
 * camelCase fields onto the real column names. No social/Google provider.
 */

const authEnv = parse(
  z.object({
    BETTER_AUTH_SECRET: z.string().min(1),
    BETTER_AUTH_URL: z.string().min(1),
    BETTER_AUTH_TRUSTED_ORIGINS: z.string().min(1),
  }),
);

const email = createEmailClient({ logger });

export const auth = betterAuth({
  database: pool,
  secret: authEnv.BETTER_AUTH_SECRET,
  baseURL: authEnv.BETTER_AUTH_URL,
  trustedOrigins: authEnv.BETTER_AUTH_TRUSTED_ORIGINS.split(',').map((o) => o.trim()),

  emailAndPassword: { enabled: true },

  user: {
    fields: {
      emailVerified: 'email_verified',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  },
  session: {
    fields: {
      userId: 'user_id',
      expiresAt: 'expires_at',
      ipAddress: 'ip_address',
      userAgent: 'user_agent',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  },
  account: {
    fields: {
      userId: 'user_id',
      accountId: 'account_id',
      providerId: 'provider_id',
      accessToken: 'access_token',
      refreshToken: 'refresh_token',
      idToken: 'id_token',
      accessTokenExpiresAt: 'access_token_expires_at',
      refreshTokenExpiresAt: 'refresh_token_expires_at',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  },
  verification: {
    fields: {
      expiresAt: 'expires_at',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  },

  plugins: [
    emailOTP({
      otpLength: 6,
      expiresIn: 300,
      async sendVerificationOTP({ email: to, otp }) {
        await email.sendOtp(to, otp);
      },
    }),
    admin({
      defaultRole: 'agent',
      adminRoles: ['admin'],
      schema: {
        user: {
          fields: {
            banReason: 'ban_reason',
            banExpires: 'ban_expires',
          },
        },
        session: {
          fields: {
            impersonatedBy: 'impersonated_by',
          },
        },
      },
    }),
    customSession(async ({ user, session }) => ({ user, session })),
  ],
});

export type Auth = typeof auth;
export type Session = typeof auth.$Infer.Session.session;
export type User = typeof auth.$Infer.Session.user;
