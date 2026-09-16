import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { twoFactor } from 'better-auth/plugins';
import { queueAfterTransactionHook } from '@better-auth/core/context';
import type { Pool } from 'pg';
import type { Config } from '../config';
import { queueEmail } from '../jobs/email';
import { log } from '../monitoring/log';
export function createAuth(
  config: Config,
  pool: Pool,
  plugins: BetterAuthPlugin[] = [],
) {
  return betterAuth({
    appName: 'Lina Terminal',
    baseURL: config.PUBLIC_URL,
    basePath: '/api/auth',
    secret: config.AUTH_SECRET,
    database: pool,
    trustedOrigins: config.origins,
    logger: {
      level: 'error',
      log: () => log('error', 'auth_dependency_error'),
    },
    onAPIError: { throw: true },
    user: {
      additionalFields: {
        role: {
          type: 'string',
          required: true,
          defaultValue: 'member',
          input: false,
        },
      },
      deleteUser: { enabled: false },
    },
    session: {
      expiresIn: 7 * 86400,
      updateAge: 86400,
      freshAge: 300,
      cookieCache: { enabled: false },
    },
    advanced: {
      useSecureCookies: config.NODE_ENV === 'production',
      ipAddress: { disableIpTracking: true },
      database: { generateId: 'uuid' },
    },
    // Rate limiting is persisted in our ingress layer, using the verified peer address.
    rateLimit: { enabled: false },
    emailAndPassword: {
      enabled: true,
      disableSignUp: !config.SIGNUP_ENABLED,
      requireEmailVerification: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 900,
      sendResetPassword: async ({ user, url }) => {
        await queueAfterTransactionHook(() =>
          queueEmail(pool, config, user.id, user.email, 'reset', url, 900),
        );
      },
      onPasswordReset: async ({ user }) => {
        await pool.query(
          "INSERT INTO security_events(user_id,event) VALUES ($1,'password_reset_completed')",
          [user.id],
        );
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: false,
      expiresIn: 3600,
      autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, url }) => {
        await queueAfterTransactionHook(() =>
          queueEmail(pool, config, user.id, user.email, 'verify', url, 3600),
        );
      },
      afterEmailVerification: async (user) => {
        await pool.query(
          "INSERT INTO security_events(user_id,event) VALUES ($1,'email_verified')",
          [user.id],
        );
      },
    },
    plugins: [
      twoFactor({ issuer: 'Lina Terminal', trustDeviceMaxAge: 0 }),
      ...plugins,
    ],
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.context.returned instanceof APIError) return;
        if (
          [
            '/two-factor/verify-totp',
            '/two-factor/verify-backup-code',
          ].includes(ctx.path)
        ) {
          const session =
            ctx.context.newSession?.session ?? ctx.context.session?.session;
          if (session)
            await queueAfterTransactionHook(async () => {
              await pool.query(
                'INSERT INTO session_factors(session_id,verified_at) VALUES ($1,now()) ON CONFLICT(session_id) DO UPDATE SET verified_at=now()',
                [session.id],
              );
              await pool.query(
                "INSERT INTO security_events(user_id,event) VALUES ($1,'mfa_verified')",
                [session.userId],
              );
              await pool.query(
                'UPDATE account_profiles SET last_login_at=now() WHERE user_id=$1',
                [session.userId],
              );
            });
        }
      }),
    },
  });
}
export type Auth = ReturnType<typeof createAuth>;
