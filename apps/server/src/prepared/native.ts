import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
} from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import type { BetterAuthPlugin } from 'better-auth';
import { transaction } from '../db';
import { HttpError } from '../http';

const secret = () => randomBytes(32).toString('base64url');
export const digest = (text: string) =>
  createHash('sha256').update(text).digest('base64url');
const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const startSchema = z.strictObject({
  challenge: opaque,
  state: opaque,
  callback: z.string().max(512),
  installationId: z.uuid(),
  platform: z.enum(['windows', 'macos', 'linux']),
  appVersion: z.string().regex(/^[0-9][0-9A-Za-z.+-]{0,39}$/),
});
export const exchangeSchema = z.strictObject({
  attemptId: z.uuid(),
  code: opaque,
  verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  state: opaque,
});
export function validateCallback(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'invalid_callback');
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    Number(url.port) < 1024 ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/lina-login\/[A-Za-z0-9_-]{43}$/.test(url.pathname) ||
    url.href !== raw
  )
    throw new HttpError(400, 'invalid_callback');
  return url.href;
}
export async function startHandoff(
  pool: Pool,
  input: z.infer<typeof startSchema>,
  origin: string,
) {
  const callback = validateCallback(input.callback),
    id = randomUUID(),
    cancelSecret = secret();
  await pool.query(
    `INSERT INTO desktop_handoffs(id,challenge,state,callback,installation_id,platform,app_version,cancel_hash,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '10 minutes')`,
    [
      id,
      input.challenge,
      input.state,
      callback,
      input.installationId,
      input.platform,
      input.appVersion,
      digest(cancelSecret),
    ],
  );
  return {
    attemptId: id,
    cancelSecret,
    authorizationUrl: `${origin}/account/desktop-authorization?attempt=${id}`,
    expiresIn: 600,
  };
}
export async function approveHandoff(
  pool: Pool,
  id: string,
  sessionId: string,
) {
  return transaction(pool, async (db) => {
    const attempt = (
      await db.query(
        `SELECT * FROM desktop_handoffs WHERE id=$1 AND expires_at>now()
      AND cancelled_at IS NULL AND consumed_at IS NULL AND code_hash IS NULL FOR UPDATE`,
        [id],
      )
    ).rows[0];
    if (!attempt) throw new HttpError(409, 'attempt_unavailable');
    const identity = (
      await db.query(
        `SELECT s.id,u.id AS user_id,u."emailVerified",u."twoFactorEnabled",f.verified_at
      FROM session s JOIN "user" u ON u.id=s."userId" LEFT JOIN session_factors f ON f.session_id=s.id
      WHERE s.id=$1 AND s."expiresAt">now() AND NOT EXISTS(SELECT 1 FROM native_sessions n WHERE n.session_id=s.id)
      FOR SHARE OF s,u`,
        [sessionId],
      )
    ).rows[0];
    if (!identity) throw new HttpError(401, 'browser_session_required');
    if (!identity.emailVerified) throw new HttpError(403, 'email_unverified');
    if (identity.twoFactorEnabled && !identity.verified_at)
      throw new HttpError(403, 'mfa_required');
    const code = secret();
    await db.query(
      `UPDATE desktop_handoffs SET code_hash=$2,code_expires_at=least(expires_at,now()+interval '60 seconds'),
      user_id=$3,browser_session_id=$4 WHERE id=$1`,
      [id, digest(code), identity.user_id, sessionId],
    );
    const callback = new URL(attempt.callback);
    callback.searchParams.set('attempt', id);
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', attempt.state);
    return {
      callbackUrl: callback.href,
      code,
      state: attempt.state,
      attemptId: id,
      expiresIn: 60,
    };
  });
}
export async function cancelHandoff(
  pool: Pool,
  id: string,
  cancelSecret: string,
) {
  await pool.query(
    `UPDATE desktop_handoffs SET cancelled_at=now() WHERE id=$1 AND cancel_hash=$2 AND consumed_at IS NULL`,
    [id, digest(cancelSecret)],
  );
  return { ok: true };
}

// Plugin is installed only by createPreparedApp, never by normal auth/startup.
export function nativePlugin(pool: Pool): BetterAuthPlugin {
  return {
    id: 'lina-prepared-native',
    endpoints: {
      exchangeLinaDesktop: createAuthEndpoint(
        '/lina-desktop/exchange',
        { method: 'POST', body: exchangeSchema },
        async (ctx) => {
          let created:
            | Awaited<
                ReturnType<typeof ctx.context.internalAdapter.createSession>
              >
            | undefined;
          try {
            const result = await transaction(pool, async (db) => {
              const attempt = (
                await db.query(
                  `SELECT * FROM desktop_handoffs WHERE id=$1 AND expires_at>now()
            AND code_expires_at>now() AND consumed_at IS NULL AND cancelled_at IS NULL FOR UPDATE`,
                  [ctx.body.attemptId],
                )
              ).rows[0];
              if (
                !attempt ||
                !equal(attempt.code_hash || '', digest(ctx.body.code)) ||
                !equal(attempt.challenge, digest(ctx.body.verifier)) ||
                !equal(attempt.state, ctx.body.state)
              )
                throw new HttpError(400, 'exchange_invalid');
              const parent = (
                await db.query(
                  `SELECT s.id,u.id AS user_id,u."emailVerified",u."twoFactorEnabled",f.verified_at FROM session s
            JOIN "user" u ON u.id=s."userId" LEFT JOIN session_factors f ON f.session_id=s.id
            WHERE s.id=$1 AND s."userId"=$2 AND s."expiresAt">now() FOR SHARE OF s,u`,
                  [attempt.browser_session_id, attempt.user_id],
                )
              ).rows[0];
              if (
                !parent ||
                !parent.emailVerified ||
                (parent.twoFactorEnabled && !parent.verified_at)
              )
                throw new HttpError(401, 'browser_session_invalid');
              created = await ctx.context.internalAdapter.createSession(
                attempt.user_id,
              );
              if (!created) throw new HttpError(503, 'session_creation_failed');
              const device = (
                await db.query(
                  `INSERT INTO devices(user_id,installation_id,platform,app_version)
            VALUES($1,$2,$3,$4) ON CONFLICT(user_id,installation_id) DO UPDATE SET platform=excluded.platform,app_version=excluded.app_version RETURNING id`,
                  [
                    attempt.user_id,
                    attempt.installation_id,
                    attempt.platform,
                    attempt.app_version,
                  ],
                )
              ).rows[0];
              await db.query(
                'INSERT INTO native_sessions(session_id,user_id,device_id) VALUES($1,$2,$3)',
                [created.id, attempt.user_id, device.id],
              );
              await db.query(
                'INSERT INTO session_devices(session_id,user_id,device_id) VALUES($1,$2,$3)',
                [created.id, attempt.user_id, device.id],
              );
              await db.query(
                'UPDATE desktop_handoffs SET consumed_at=now() WHERE id=$1',
                [attempt.id],
              );
              await db.query(
                "INSERT INTO security_events(user_id,event) VALUES($1,'desktop_login_succeeded')",
                [attempt.user_id],
              );
              return {
                deviceId: device.id,
                userId: attempt.user_id,
                sessionId: created.id,
              };
            });
            // Library-owned signing/cookie format; the JSON contains no session token.
            const user = await ctx.context.internalAdapter.findUserById(
              result.userId,
            );
            if (!user || !created)
              throw new HttpError(503, 'session_creation_failed');
            await setSessionCookie(ctx, { session: created, user });
            return ctx.json(result);
          } catch (error) {
            if (created)
              await ctx.context.internalAdapter
                .deleteSession(created.token)
                .catch(() => {});
            throw error;
          }
        },
      ),
    },
  };
}
