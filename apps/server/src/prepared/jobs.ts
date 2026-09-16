import type { Pool } from 'pg';
import type { createBilling } from './billing';
// The normal worker never imports this module. A future host explicitly calls
// tick; there are no timers or connections here. Sweep repairs missed webhooks.
export function createPreparedJobs(
  pool: Pool,
  billing: ReturnType<typeof createBilling>,
) {
  let running = false,
    cursor: string | null = null;
  return {
    async tick() {
      if (running) return { busy: true };
      running = true;
      try {
        const processed = await billing.work();
        const rows = (
          await pool.query(
            `SELECT user_id,customer_id FROM billing_accounts WHERE customer_id IS NOT NULL
        AND ($1::uuid IS NULL OR user_id>$1) AND updated_at<now()-interval '5 minutes' ORDER BY user_id LIMIT 25`,
            [cursor],
          )
        ).rows;
        let reconciled = 0,
          failed = 0;
        for (const row of rows) {
          try {
            await billing.reconcile(row.customer_id);
            reconciled++;
          } catch {
            failed++;
          }
        }
        cursor = rows.length === 25 ? rows[rows.length - 1].user_id : null;
        await pool.query(
          "DELETE FROM desktop_handoffs WHERE expires_at<now()-interval '1 hour'",
        );
        await pool.query(
          "DELETE FROM billing_inbox WHERE processed_at<now()-interval '30 days'",
        );
        await pool.query(
          "DELETE FROM billing_audit WHERE created_at<now()-interval '365 days'",
        );
        await pool.query(
          `INSERT INTO job_status(name,last_success_at,last_failure_at,result_count)
        VALUES('billing_sweep',CASE WHEN $1=0 THEN now() END,CASE WHEN $1>0 THEN now() END,$2)
        ON CONFLICT(name) DO UPDATE SET last_success_at=coalesce(excluded.last_success_at,job_status.last_success_at),
        last_failure_at=coalesce(excluded.last_failure_at,job_status.last_failure_at),result_count=$2`,
          [failed, reconciled],
        );
        return { processed, reconciled, failed };
      } finally {
        running = false;
      }
    },
  };
}
