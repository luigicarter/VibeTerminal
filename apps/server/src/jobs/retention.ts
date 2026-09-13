import type { Pool } from 'pg';
import { transaction } from '../db';
export async function retainAndAggregate(pool: Pool) {
  return transaction(pool, async (db) => {
    const lock = await db.query(
      'SELECT pg_try_advisory_xact_lock(82144703) AS locked',
    );
    if (!lock.rows[0].locked) return false;
    // Recompute only complete UTC days still fully represented by the raw window.
    await db.query(`INSERT INTO activity_daily(user_id,day,event,count)
      SELECT user_id,(received_at AT TIME ZONE 'UTC')::date,event,count(*)::int FROM activity_events
      WHERE received_at >= (date_trunc('day',now() AT TIME ZONE 'UTC')-interval '29 days') AT TIME ZONE 'UTC'
      AND received_at < date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      GROUP BY user_id,(received_at AT TIME ZONE 'UTC')::date,event
      ON CONFLICT(user_id,day,event) DO UPDATE SET count=excluded.count`);
    await db.query(
      "DELETE FROM activity_events WHERE received_at<now()-interval '30 days'",
    );
    await db.query(
      "DELETE FROM activity_daily WHERE day<(now() AT TIME ZONE 'UTC')::date-365",
    );
    await db.query('DELETE FROM activity_dedupe WHERE expires_at<now()');
    await db.query(
      "DELETE FROM security_events WHERE created_at<now()-interval '90 days'",
    );
    await db.query(
      "DELETE FROM admin_audit_events WHERE created_at<now()-interval '365 days'",
    );
    await db.query('DELETE FROM session WHERE "expiresAt"<now()');
    await db.query('DELETE FROM verification WHERE "expiresAt"<now()');
    await db.query('DELETE FROM rate_limits WHERE expires_at<now()');
    await db.query(
      "DELETE FROM email_outbox WHERE expires_at<now()-interval '7 days'",
    );
    await db.query(
      "INSERT INTO job_status(name,last_success_at) VALUES('retention',now()) ON CONFLICT(name) DO UPDATE SET last_success_at=now()",
    );
    return true;
  });
}
