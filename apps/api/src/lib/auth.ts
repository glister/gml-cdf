import { createHash } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { admin, captcha, customSession, emailOTP } from 'better-auth/plugins';
import { appendEvent, db, newUuidV7, pool } from '@repo/db';
import { createEmailClient } from '@repo/email';
import { parse, z } from '@repo/env';
import {
  ensurePersonForNewUser,
  resolvePersonByUserId,
  resolveSignInContext,
} from '@repo/identity';
import { logger } from '../logger.js';

/**
 * Better Auth instance (core plan 03, ADR-0014). Two sign-in doors:
 *  - **Entra ID OIDC** for employees (Microsoft social provider, single-tenant).
 *  - **Email OTP** for externals — sign-up disabled (`disableSignUp: true`), so
 *    OTP only works for invitation-provisioned accounts (PL-036).
 *
 * Password sign-in is removed (SoW is SSO + OTP only, NFR-001). Administrators
 * are Entra employees; a provisioned OTP account is a valid break-glass (Q2).
 *
 * The Entra provider and the Turnstile captcha ship **inert** until their secrets
 * are supplied (`.env.secrets`): each is added to the config only when its
 * credentials are present, so dev/CI boot and tests run without them (open
 * question Q1). Our DB columns are snake_case, so each model maps Better Auth's
 * camelCase fields onto the real column names.
 */

const authEnv = parse(
  z.object({
    BETTER_AUTH_SECRET: z.string().min(1),
    BETTER_AUTH_URL: z.string().min(1),
    BETTER_AUTH_TRUSTED_ORIGINS: z.string().min(1),
    // Identity providers — all optional; the config gates on their presence.
    ENTRA_TENANT_ID: z.string().optional(),
    ENTRA_CLIENT_ID: z.string().optional(),
    ENTRA_CLIENT_SECRET: z.string().optional(),
    TURNSTILE_SECRET_KEY: z.string().optional(),
  }),
);

const email = createEmailClient({ logger });

/** A non-reversible surrogate for the credential subject (never journal raw PII). */
function hashSubject(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

// Entra is configured only when all three ids are present (secret lives in
// .env.secrets); otherwise the Microsoft door ships inert (open question Q1).
const entraConfigured = Boolean(
  authEnv.ENTRA_TENANT_ID && authEnv.ENTRA_CLIENT_ID && authEnv.ENTRA_CLIENT_SECRET,
);

// The OTP endpoints protected by rate limiting + captcha (PL-044).
const OTP_SEND_PATH = '/email-otp/send-verification-otp';
const OTP_VERIFY_PATH = '/sign-in/email-otp';

const plugins = [
  emailOTP({
    otpLength: 6,
    expiresIn: 300,
    // External accounts exist only by invitation (PL-036): an OTP request for an
    // email with no pre-provisioned user is refused — no visitor self-signup.
    disableSignUp: true,
    async sendVerificationOTP({ email: to, otp }) {
      await email.sendOtp(to, otp);
    },
  }),
  admin({
    defaultRole: 'agent',
    adminRoles: ['admin'],
    schema: {
      user: { fields: { banReason: 'ban_reason', banExpires: 'ban_expires' } },
      session: { fields: { impersonatedBy: 'impersonated_by' } },
    },
  }),
  // personId is surfaced on the session so the web client and the tRPC context
  // can read it without a second round-trip (§5 customSession).
  customSession(async ({ user, session }) => {
    const resolved = await resolvePersonByUserId(db, user.id);
    return { user, session, personId: resolved?.personId ?? null };
  }),
  // Turnstile bot protection on OTP send (PL-044, Q3) — included only when its
  // secret is present so dev/CI and tests run without it.
  ...(authEnv.TURNSTILE_SECRET_KEY
    ? [
        captcha({
          provider: 'cloudflare-turnstile',
          secretKey: authEnv.TURNSTILE_SECRET_KEY,
          endpoints: [OTP_SEND_PATH],
        }),
      ]
    : []),
];

export const auth = betterAuth({
  database: pool,
  secret: authEnv.BETTER_AUTH_SECRET,
  baseURL: authEnv.BETTER_AUTH_URL,
  trustedOrigins: authEnv.BETTER_AUTH_TRUSTED_ORIGINS.split(',').map((o) => o.trim()),
  plugins,

  // SSO + OTP only (NFR-001); password sign-in removed.
  emailAndPassword: { enabled: false },

  ...(entraConfigured
    ? {
        socialProviders: {
          microsoft: {
            clientId: authEnv.ENTRA_CLIENT_ID!,
            clientSecret: authEnv.ENTRA_CLIENT_SECRET!,
            tenantId: authEnv.ENTRA_TENANT_ID!,
            prompt: 'select_account',
          },
        },
      }
    : {}),

  // Database-backed rate limiting so OTP limits hold across API replicas (PL-044).
  rateLimit: {
    enabled: true,
    storage: 'database',
    modelName: 'rate_limit',
    fields: { lastRequest: 'last_request' },
    customRules: {
      [OTP_SEND_PATH]: { window: 600, max: 3 },
      [OTP_VERIFY_PATH]: { window: 600, max: 5 },
    },
  },

  user: {
    additionalFields: {
      // The link to platform.person. input:false — no client can set it; the
      // framework round-trips it. Stays nullable (the Entra hook attaches AFTER
      // Better Auth inserts the user — see the plan change log re task 9.1-6).
      personId: { type: 'string', required: false, input: false, fieldName: 'person_id' },
    },
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

  databaseHooks: {
    user: {
      create: {
        // Entra path only: invited users are created via the adapter (not Better
        // Auth), so they never reach this hook. Attach to a person matching the
        // verified email, else create an employee at draft_shell (never active).
        // The person insert + its journal event share one transaction (ADR-0010);
        // the framework's own user insert commits separately (§5 note).
        after: async (user) => {
          if ((user as { personId?: string | null }).personId) return;
          await db.transaction().execute(async (trx) => {
            const { personId, created } = await ensurePersonForNewUser(trx, {
              userId: user.id,
              email: user.email,
              name: user.name,
            });
            if (created) {
              await appendEvent(trx, {
                kind: 'security',
                streamType: 'platform.person',
                streamId: personId,
                eventType: 'platform.person.created',
                payload: { relationshipType: 'employee', via: 'first_sso' },
                actorPersonId: personId,
                correlationId: newUuidV7(),
              });
            } else {
              await appendEvent(trx, {
                kind: 'security',
                streamType: 'platform.person',
                streamId: personId,
                eventType: 'platform.person.credential_linked',
                payload: { providerId: 'microsoft', subjectHash: hashSubject(user.id) },
                actorPersonId: personId,
                correlationId: newUuidV7(),
              });
            }
          });
        },
      },
    },
    session: {
      create: {
        // Journal the sign-in against the resolved person (plan 13 activity trail).
        // Belt-and-braces on top of the ban is handled by the framework: a banned
        // user cannot reach session creation.
        after: async (session) => {
          const resolved = await resolveSignInContext(db, session.userId);
          if (!resolved) return;
          await db.transaction().execute((trx) =>
            appendEvent(trx, {
              kind: 'security',
              streamType: 'platform.person',
              streamId: resolved.personId,
              eventType: 'platform.person.signed_in',
              payload: { providerId: resolved.providerId },
              actorPersonId: resolved.personId,
              correlationId: newUuidV7(),
            }),
          );
        },
      },
    },
  },
});

export type Auth = typeof auth;
export type Session = typeof auth.$Infer.Session.session;
export type User = typeof auth.$Infer.Session.user;
