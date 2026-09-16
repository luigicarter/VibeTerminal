import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { transaction } from '../db';
import { HttpError } from '../http';

export type Tier = 'full_access' | 'orchestrator';
export type Interval = 'month' | 'year';
export type BillingEvent = {
  id: string;
  type: string;
  customerId: string;
  objectId: string;
};
export type BillingSnapshot = {
  subscriptionId: string | null;
  status: string;
  tier: Tier | null;
  paidThrough: number | null;
  cancelAtPeriodEnd: boolean;
  held: boolean;
  fullyRefunded: boolean;
};
export interface BillingTransport {
  verify(payload: string, signature: string): Promise<BillingEvent>;
  customer(userId: string): Promise<string>;
  checkout(input: {
    customerId: string;
    tier: Tier;
    interval: Interval;
    key: string;
    expiresAt: number;
    returnOrigin: string;
  }): Promise<{ id: string; url: string }>;
  portal(customerId: string, returnOrigin: string): Promise<{ url: string }>;
  resolveCustomer(event: BillingEvent): Promise<string>;
  snapshot(customerId: string): Promise<BillingSnapshot>;
}
export const checkoutSchema = z.strictObject({
  tier: z.enum(['full_access', 'orchestrator']),
  interval: z.enum(['month', 'year']),
});
const supported = new Set([
  'checkout.session.completed',
  'checkout.session.expired',
  'invoice.paid',
  'invoice.payment_failed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'charge.refunded',
  'charge.dispute.created',
  'charge.dispute.updated',
  'charge.dispute.closed',
]);
const activeSubscription = (status: string) =>
  !['none', 'canceled', 'incomplete_expired'].includes(status);
export function stripeUrl(raw: string, kind: 'checkout' | 'portal') {
  const url = new URL(raw);
  if (
    url.protocol !== 'https:' ||
    url.hostname !==
      (kind === 'checkout' ? 'checkout.stripe.com' : 'billing.stripe.com') ||
    url.port ||
    url.username ||
    url.password
  )
    throw new HttpError(503, 'billing_url_invalid');
  return url.href;
}
export function createBilling(
  pool: Pool,
  transport: BillingTransport | undefined,
  origin: string,
) {
  const provider = () => {
    if (!transport) throw new HttpError(503, 'billing_not_configured');
    return transport;
  };
  async function status(userId: string) {
    const result = await pool.query(
      `SELECT subscription_status AS status,paid_through AS "paidThrough",cancel_at_period_end AS "cancelAtPeriodEnd"
      FROM billing_accounts WHERE user_id=$1`,
      [userId],
    );
    return {
      configured: !!transport,
      ...(result.rows[0] || { paidThrough: null, cancelAtPeriodEnd: false }),
      status: result.rows[0]?.status || 'none',
    };
  }
  async function checkout(
    userId: string,
    input: z.infer<typeof checkoutSchema>,
  ) {
    const stripe = provider();
    const reservation = await transaction(pool, async (db) => {
      const account = (
        await db.query(
          `SELECT p.status,u."emailVerified" FROM account_profiles p JOIN "user" u ON u.id=p.user_id
        WHERE p.user_id=$1 FOR UPDATE OF p`,
          [userId],
        )
      ).rows[0];
      if (
        !account?.emailVerified ||
        !['pending', 'active'].includes(account.status)
      )
        throw new HttpError(403, 'checkout_not_allowed');
      if (
        account.status === 'pending' &&
        (
          await db.query(
            `SELECT 1 FROM admin_audit_events WHERE target_id=$1 AND after_state->>'status'='closed' LIMIT 1`,
            [userId],
          )
        ).rowCount
      )
        throw new HttpError(403, 'account_review_required');
      await db.query(
        'INSERT INTO billing_accounts(user_id) VALUES($1) ON CONFLICT DO NOTHING',
        [userId],
      );
      const current = (
        await db.query(
          'SELECT *,now() AS now FROM billing_accounts WHERE user_id=$1 FOR UPDATE',
          [userId],
        )
      ).rows[0];
      const customerId = current.customer_id || (await stripe.customer(userId));
      // Authoritative check catches a successful checkout whose webhook is delayed.
      if (activeSubscription((await stripe.snapshot(customerId)).status))
        throw new HttpError(409, 'subscription_exists');
      if (current.checkout_expires_at > current.now && current.checkout_key) {
        if (
          current.checkout_tier !== input.tier ||
          current.checkout_interval !== input.interval
        )
          throw new HttpError(409, 'checkout_in_progress');
        if (current.checkout_url)
          return {
            url: stripeUrl(current.checkout_url, 'checkout'),
            key: current.checkout_key,
          };
      }
      const key =
        current.checkout_expires_at > current.now
          ? current.checkout_key
          : randomUUID();
      const expiresAt = Math.floor(
        (current.checkout_expires_at > current.now
          ? current.checkout_expires_at.getTime()
          : current.now.getTime() + 1860000) / 1000,
      );
      await db.query(
        `UPDATE billing_accounts SET customer_id=$2,checkout_key=$3,checkout_id=NULL,checkout_url=NULL,
        checkout_expires_at=to_timestamp($4),checkout_tier=$5,checkout_interval=$6,updated_at=now() WHERE user_id=$1`,
        [userId, customerId, key, expiresAt, input.tier, input.interval],
      );
      return { key, url: null };
    });
    if (reservation.url) return { url: reservation.url };
    // Reservation is committed BEFORE the external request. A timeout/restart
    // retries the same provider idempotency key instead of creating a second checkout.
    return transaction(pool, async (db) => {
      const profile = (
        await db.query(
          'SELECT status FROM account_profiles WHERE user_id=$1 FOR UPDATE',
          [userId],
        )
      ).rows[0];
      const row = (
        await db.query(
          'SELECT * FROM billing_accounts WHERE user_id=$1 FOR UPDATE',
          [userId],
        )
      ).rows[0];
      row.account_status = profile.status;
      if (
        row.checkout_key !== reservation.key ||
        !['pending', 'active'].includes(row.account_status)
      )
        throw new HttpError(409, 'checkout_unavailable');
      if (row.checkout_url)
        return { url: stripeUrl(row.checkout_url, 'checkout') };
      const session = await stripe.checkout({
        customerId: row.customer_id,
        ...input,
        key: row.checkout_key,
        expiresAt: Math.floor(row.checkout_expires_at.getTime() / 1000),
        returnOrigin: origin,
      });
      const url = stripeUrl(session.url, 'checkout');
      await db.query(
        'UPDATE billing_accounts SET checkout_id=$2,checkout_url=$3 WHERE user_id=$1',
        [userId, session.id, url],
      );
      return { url };
    });
  }
  async function portal(userId: string) {
    const row = (
      await pool.query(
        'SELECT customer_id FROM billing_accounts WHERE user_id=$1',
        [userId],
      )
    ).rows[0];
    if (!row?.customer_id) throw new HttpError(409, 'billing_account_missing');
    return {
      url: stripeUrl(
        (await provider().portal(row.customer_id, origin)).url,
        'portal',
      ),
    };
  }
  async function ingest(payload: string, signature: string) {
    let event: BillingEvent;
    try {
      event = await provider().verify(payload, signature);
    } catch {
      throw new HttpError(400, 'webhook_invalid');
    }
    if (!supported.has(event.type)) return { accepted: true };
    if (
      !/^evt_[A-Za-z0-9]+$/.test(event.id) ||
      !event.objectId ||
      event.objectId.length > 255 ||
      event.customerId.length > 255
    )
      throw new HttpError(400, 'webhook_invalid');
    await pool.query(
      `INSERT INTO billing_inbox(event_id,customer_id,event_type,object_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [event.id, event.customerId, event.type, event.objectId],
    );
    return { accepted: true };
  }
  async function reconcile(customerId: string, eventId: string | null = null) {
    return transaction(pool, async (db) => {
      // Lock before reading Stripe so slower, older snapshots cannot overwrite a later one.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        customerId,
      ]);
      const owner = (
        await db.query(
          'SELECT user_id FROM billing_accounts WHERE customer_id=$1',
          [customerId],
        )
      ).rows[0];
      if (!owner) throw new HttpError(409, 'billing_owner_unknown');
      const profile = (
        await db.query(
          'SELECT status FROM account_profiles WHERE user_id=$1 FOR UPDATE',
          [owner.user_id],
        )
      ).rows[0];
      const row = (
        await db.query(
          'SELECT * FROM billing_accounts WHERE user_id=$1 FOR UPDATE',
          [owner.user_id],
        )
      ).rows[0];
      row.account_status = profile.status;
      const snapshot = await provider().snapshot(customerId);
      if (
        snapshot.subscriptionId &&
        row.subscription_id &&
        snapshot.subscriptionId !== row.subscription_id &&
        activeSubscription(row.subscription_status || 'none')
      )
        throw new HttpError(409, 'subscription_identity_conflict');
      const now = (await db.query('SELECT now() AS now')).rows[0].now.getTime();
      const valid =
        ['active', 'past_due', 'unpaid', 'canceled'].includes(
          snapshot.status,
        ) &&
        snapshot.tier &&
        snapshot.paidThrough &&
        snapshot.paidThrough * 1000 > now &&
        !snapshot.held &&
        !snapshot.fullyRefunded;
      const before = {
        status: row.subscription_status,
        paidThrough: row.paid_through,
        accountStatus: row.account_status,
      };
      const grant = (
        await db.query(
          `SELECT * FROM access_grants WHERE user_id=$1 AND source='stripe' AND revoked_at IS NULL`,
          [row.user_id],
        )
      ).rows[0];
      const same =
        valid &&
        grant &&
        grant.plan_id === snapshot.tier &&
        grant.expires_at.getTime() === snapshot.paidThrough! * 1000;
      if (!same && grant)
        await db.query(
          'UPDATE access_grants SET revoked_at=now() WHERE id=$1',
          [grant.id],
        );
      if (valid && !same)
        await db.query(
          `INSERT INTO access_grants(user_id,plan_id,source,expires_at,reason)
        VALUES($1,$2,'stripe',to_timestamp($3),'Verified subscription payment')`,
          [row.user_id, snapshot.tier, snapshot.paidThrough],
        );
      let activated = false;
      if (valid && row.account_status === 'pending') {
        const eligible = await db.query(
          `SELECT 1 FROM "user" u WHERE u.id=$1 AND u."emailVerified" AND NOT EXISTS
          (SELECT 1 FROM admin_audit_events a WHERE a.target_id=u.id AND a.after_state->>'status' IN ('closed','suspended'))`,
          [row.user_id],
        );
        if (eligible.rowCount) {
          await db.query(
            "UPDATE account_profiles SET status='active',approved_at=now(),status_changed_at=now(),reason='Verified subscription payment' WHERE user_id=$1",
            [row.user_id],
          );
          activated = true;
        }
      }
      if ((!same && (valid || grant)) || activated)
        await db.query(
          'UPDATE account_profiles SET revision=revision+1 WHERE user_id=$1',
          [row.user_id],
        );
      await db.query(
        `UPDATE billing_accounts SET subscription_id=$2,subscription_status=$3,paid_through=to_timestamp($4),cancel_at_period_end=$5,updated_at=now()
        WHERE user_id=$1`,
        [
          row.user_id,
          snapshot.subscriptionId,
          snapshot.status,
          snapshot.paidThrough,
          snapshot.cancelAtPeriodEnd,
        ],
      );
      const after = {
        status: snapshot.status,
        paidThrough: snapshot.paidThrough,
        accountStatus: activated ? 'active' : row.account_status,
        held: snapshot.held,
        fullyRefunded: snapshot.fullyRefunded,
      };
      await db.query(
        `INSERT INTO billing_audit(user_id,event_id,action,before_state,after_state) VALUES($1,$2,'reconciled',$3,$4) ON CONFLICT DO NOTHING`,
        [row.user_id, eventId, before, after],
      );
    });
  }
  async function work(limit = 25) {
    const rows = (
      await pool.query(
        `SELECT * FROM billing_inbox WHERE processed_at IS NULL AND next_attempt_at<=now() ORDER BY received_at,event_id LIMIT $1`,
        [Math.min(Math.max(limit, 1), 100)],
      )
    ).rows;
    let processed = 0,
      failed = 0;
    for (const row of rows) {
      try {
        const customer =
          row.customer_id ||
          (await provider().resolveCustomer({
            id: row.event_id,
            type: row.event_type,
            customerId: row.customer_id,
            objectId: row.object_id,
          }));
        await reconcile(customer, row.event_id);
        await pool.query(
          'UPDATE billing_inbox SET processed_at=now(),last_error=NULL WHERE event_id=$1',
          [row.event_id],
        );
        processed++;
      } catch {
        failed++;
        await pool.query(
          `UPDATE billing_inbox SET attempts=attempts+1,last_error='reconciliation_failed',
          next_attempt_at=now()+least(3600,power(2,least(attempts+1,10))) * interval '1 second' WHERE event_id=$1`,
          [row.event_id],
        );
      }
    }
    await pool.query(
      `INSERT INTO job_status(name,last_success_at,last_failure_at,result_count)
      VALUES('billing',CASE WHEN $2=0 THEN now() END,CASE WHEN $2>0 THEN now() END,$1)
      ON CONFLICT(name) DO UPDATE SET last_success_at=coalesce(excluded.last_success_at,job_status.last_success_at),
      last_failure_at=coalesce(excluded.last_failure_at,job_status.last_failure_at),result_count=$1`,
      [processed, failed],
    );
    return processed;
  }
  return { status, checkout, portal, ingest, reconcile, work };
}
