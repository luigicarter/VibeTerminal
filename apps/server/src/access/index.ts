import type { Pool, PoolClient } from 'pg';
export type Queryable = Pick<Pool | PoolClient, 'query'>;
export async function accessFor(db: Queryable, userId: string) {
  const { rows } = await db.query(
    'SELECT p.status,p.revision,u."emailVerified",now() AS server_time FROM "user" u LEFT JOIN account_profiles p ON p.user_id=u.id WHERE u.id=$1',
    [userId],
  );
  const u = rows[0];
  let reason = !u
    ? 'account_missing'
    : !u.emailVerified
      ? 'email_unverified'
      : !u.status
        ? 'profile_missing'
        : u.status !== 'active'
          ? `account_${u.status}`
          : null;
  const grants = await db.query(
    'SELECT g.*,p.features,p.rank FROM access_grants g JOIN plans p ON p.id=g.plan_id WHERE g.user_id=$1 AND g.revoked_at IS NULL ORDER BY p.rank DESC,g.expires_at DESC NULLS FIRST',
    [userId],
  );
  const now = (u?.server_time as Date) || new Date();
  const grant = grants.rows.find(
    (g) => g.starts_at <= now && (!g.expires_at || g.expires_at > now),
  );
  if (!reason && !grant)
    reason = grants.rows.some((g) => g.expires_at && g.expires_at <= now)
      ? 'access_expired'
      : 'no_access_grant';
  return {
    allowed: !reason,
    reason,
    tier: reason ? null : (grant.plan_id as string),
    features: reason ? [] : (grant.features as string[]),
    expiresAt: reason ? null : grant.expires_at,
    revision: u?.revision ?? 0,
    accountStatus: u?.status ?? 'missing',
    serverTime: now,
  };
}
