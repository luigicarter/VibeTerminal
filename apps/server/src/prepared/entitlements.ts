import { createPrivateKey, sign } from 'node:crypto';
import type { Pool } from 'pg';
import { accessFor } from '../access';
import { HttpError } from '../http';
import { transaction } from '../db';

export type LeaseSigner = { issuer: string; keyId: string; privateKey: string };
export async function issueEntitlement(
  pool: Pool,
  sessionId: string,
  signer: LeaseSigner,
) {
  return transaction(pool, async (db) => {
    const result = await db.query(
      `SELECT s."userId" AS user_id,s."expiresAt" AS expires_at,n.device_id,now() AS now
    FROM session s JOIN native_sessions n ON n.session_id=s.id JOIN account_profiles p ON p.user_id=s."userId" JOIN "user" u ON u.id=p.user_id
    WHERE s.id=$1 AND s."expiresAt">now() FOR SHARE OF s,p,u`,
      [sessionId],
    );
    const session = result.rows[0];
    if (!session) throw new HttpError(401, 'native_session_required');
    const access = await accessFor(db, session.user_id);
    if (!access.allowed) throw new HttpError(403, access.reason!);
    const issuedAt = Math.floor(session.now.getTime() / 1000);
    const expiresAt = Math.floor(
      Math.min(
        session.now.getTime() + 86400000,
        session.expires_at.getTime(),
        access.expiresAt ? new Date(access.expiresAt).getTime() : Infinity,
      ) / 1000,
    );
    const header = Buffer.from(
      JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: signer.keyId }),
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: signer.issuer,
        aud: 'lina-desktop',
        sub: session.user_id,
        sid: sessionId,
        device: session.device_id,
        tier: access.tier,
        features: access.features,
        revision: access.revision,
        iat: issuedAt,
        exp: expiresAt,
      }),
    ).toString('base64url');
    const key = createPrivateKey(signer.privateKey);
    if (key.asymmetricKeyType !== 'ed25519')
      throw new Error('Invalid entitlement signing key');
    const input = `${header}.${payload}`;
    return {
      entitlement: `${input}.${sign(null, Buffer.from(input), key).toString('base64url')}`,
      access,
    };
  });
}
