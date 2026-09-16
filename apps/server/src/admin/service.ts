import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { transaction } from '../db';
import { HttpError } from '../http';
export type Change = {
  expectedRevision: number;
  reason: string;
  status?: string;
  tier?: string;
  expiresAt?: string | null;
  role?: string;
};
export async function snapshot(db: PoolClient, id: string) {
  const result = await db.query(
    'SELECT p.*,u.role,u."emailVerified" FROM account_profiles p JOIN "user" u ON u.id=p.user_id WHERE p.user_id=$1 FOR UPDATE OF p,u',
    [id],
  );
  if (!result.rows[0]) throw new HttpError(404, 'account_not_found');
  const u = result.rows[0];
  const grants = await db.query(
    'SELECT plan_id,source,expires_at FROM access_grants WHERE user_id=$1 AND revoked_at IS NULL',
    [id],
  );
  return {
    status: u.status,
    role: u.role,
    emailVerified: u.emailVerified,
    revision: u.revision,
    grants: grants.rows,
  };
}
export async function changeAccount(
  pool: Pool,
  actorId: string,
  targetId: string,
  action: string,
  body: Change,
  requestId: string,
  sessionId: string,
) {
  return transaction(pool, async (db) => {
    // Serializes owner-count and role/status mutations, including conflicting targets.
    await db.query('SELECT pg_advisory_xact_lock(82144702)');
    const actor = await db.query(
      `SELECT u.role,p.status FROM "user" u JOIN account_profiles p ON p.user_id=u.id
      JOIN session s ON s."userId"=u.id AND s.id=$2 JOIN session_factors f ON f.session_id=s.id
      WHERE u.id=$1 AND u."twoFactorEnabled" AND s."expiresAt">now()
      AND s."createdAt">now()-interval '5 minutes' AND f.verified_at>now()-interval '5 minutes'
      FOR SHARE OF u,p,s`,
      [actorId, sessionId],
    );
    if (
      !actor.rows[0] ||
      !['owner', 'admin'].includes(actor.rows[0].role) ||
      actor.rows[0].status !== 'active'
    )
      throw new HttpError(403, 'admin_required');
    const before = await snapshot(db, targetId);
    if (before.revision !== body.expectedRevision)
      throw new HttpError(409, 'revision_conflict');
    if (
      (before.role !== 'member' || action === 'role') &&
      actor.rows[0].role !== 'owner'
    )
      throw new HttpError(403, 'owner_required');
    if (
      before.role === 'owner' &&
      ((action === 'status' && body.status !== 'active') ||
        (action === 'role' && body.role !== 'owner'))
    ) {
      const n = await db.query(
        "SELECT count(*)::int AS n FROM \"user\" u JOIN account_profiles p ON p.user_id=u.id WHERE u.role='owner' AND p.status='active'",
      );
      if (n.rows[0].n <= 1) throw new HttpError(409, 'last_owner');
    }
    if (action === 'approve') {
      if (!before.emailVerified) throw new HttpError(409, 'email_unverified');
      if (before.status !== 'pending')
        throw new HttpError(409, 'account_not_pending');
      await db.query(
        "UPDATE account_profiles SET status='active',approved_at=now() WHERE user_id=$1",
        [targetId],
      );
    }
    if (action === 'approve' || action === 'access') {
      if (body.expiresAt && new Date(body.expiresAt).getTime() <= Date.now())
        throw new HttpError(400, 'invalid_expiry');
      if (action === 'access' && before.status !== 'active')
        throw new HttpError(409, 'account_not_active');
      await db.query(
        "UPDATE access_grants SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL AND source<>'stripe'",
        [targetId],
      );
      await db.query(
        "INSERT INTO access_grants(user_id,plan_id,source,expires_at,issued_by,reason) VALUES ($1,$2,'manual',$3,$4,$5)",
        [targetId, body.tier, body.expiresAt ?? null, actorId, body.reason],
      );
    } else if (action === 'status') {
      const transitions: Record<string, string[]> = {
        pending: ['closed'],
        active: ['suspended', 'closed'],
        suspended: ['active', 'closed'],
        closed: ['pending'],
      };
      if (!transitions[before.status]?.includes(body.status!))
        throw new HttpError(409, 'invalid_status_transition');
      await db.query('UPDATE account_profiles SET status=$2 WHERE user_id=$1', [
        targetId,
        body.status,
      ]);
      if (body.status === 'pending')
        await db.query(
          'UPDATE access_grants SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',
          [targetId],
        );
    } else if (action === 'revoke-access') {
      await db.query(
        "UPDATE access_grants SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL AND source<>'stripe'",
        [targetId],
      );
    } else if (action === 'revoke-sessions') {
      await db.query('DELETE FROM session WHERE "userId"=$1', [targetId]);
    } else if (action === 'role') {
      if (!before.emailVerified || before.status !== 'active')
        throw new HttpError(409, 'active_verified_account_required');
      await db.query('UPDATE "user" SET role=$2 WHERE id=$1', [
        targetId,
        body.role,
      ]);
      // Role elevation requires a fresh sign-in/MFA; old sessions do not gain admin access.
      await db.query('DELETE FROM session WHERE "userId"=$1', [targetId]);
    } else if (action !== 'approve' && action !== 'access')
      throw new HttpError(400, 'invalid_action');
    await db.query(
      'UPDATE account_profiles SET revision=revision+1,changed_by=$2,reason=$3,status_changed_at=now() WHERE user_id=$1',
      [targetId, actorId, body.reason],
    );
    const after = await snapshot(db, targetId);
    await db.query(
      'INSERT INTO admin_audit_events(actor_id,target_id,action,before_state,after_state,reason,request_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [actorId, targetId, action, before, after, body.reason, requestId],
    );
    return after;
  });
}
export async function bootstrapOwner(pool: Pool, id: string) {
  return transaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(82144702)');
    const owners = await db.query('SELECT id FROM "user" WHERE role=\'owner\'');
    if (owners.rowCount) throw new HttpError(409, 'owner_already_exists');
    const before = await snapshot(db, id);
    if (!before.emailVerified) throw new HttpError(409, 'email_unverified');
    await db.query('UPDATE "user" SET role=\'owner\' WHERE id=$1', [id]);
    await db.query(
      "UPDATE account_profiles SET status='active',approved_at=now(),revision=revision+1 WHERE user_id=$1",
      [id],
    );
    await db.query('DELETE FROM session WHERE "userId"=$1', [id]);
    await db.query(
      "INSERT INTO admin_audit_events(target_id,action,before_state,after_state,reason,request_id) VALUES ($1,'bootstrap_owner',$2,$3,'Server CLI owner bootstrap',$4)",
      [id, before, await snapshot(db, id), randomUUID()],
    );
  });
}
