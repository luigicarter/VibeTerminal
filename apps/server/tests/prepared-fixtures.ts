import Stripe from 'stripe';
import { randomBytes } from 'node:crypto';
import type {
  BillingTransport,
  BillingSnapshot,
} from '../src/prepared/billing';
export function stripeFixture() {
  const stripe = new Stripe('sk_test_synthetic_fixture_only'),
    secret = 'whsec_' + randomBytes(32).toString('hex');
  const customers = new Map<string, string>(),
    snapshots = new Map<string, BillingSnapshot>(),
    checkouts = new Map<string, { id: string; url: string }>();
  let failAfterCreate = false,
    unavailable = false;
  const transport: BillingTransport = {
    async verify(payload, signature) {
      const e = await stripe.webhooks.constructEventAsync(
        payload,
        signature,
        secret,
        300,
      );
      if (e.livemode) throw Error('live_event');
      const o = e.data.object as unknown as { id: string; customer: string };
      return {
        id: e.id,
        type: e.type,
        objectId: o.id,
        customerId: o.customer || '',
      };
    },
    async customer(userId) {
      if (!customers.has(userId))
        customers.set(userId, 'cus_' + userId.replaceAll('-', ''));
      return customers.get(userId)!;
    },
    async checkout(input) {
      let value = checkouts.get(input.key);
      if (!value) {
        value = {
          id: 'cs_test_' + input.key.replaceAll('-', ''),
          url: 'https://checkout.stripe.com/c/pay/' + input.key,
        };
        checkouts.set(input.key, value);
      }
      if (failAfterCreate) {
        failAfterCreate = false;
        throw Error('simulated_lost_response');
      }
      return value;
    },
    async portal() {
      return { url: 'https://billing.stripe.com/p/session/test' };
    },
    async resolveCustomer(event) {
      return event.customerId;
    },
    async snapshot(customer) {
      if (unavailable) throw Error('simulated_outage');
      return structuredClone(
        snapshots.get(customer) || {
          subscriptionId: null,
          status: 'none',
          tier: null,
          paidThrough: null,
          cancelAtPeriodEnd: false,
          held: false,
          fullyRefunded: false,
        },
      );
    },
  };
  async function event(
    customer: string,
    type = 'invoice.paid',
    extra: Record<string, unknown> = {},
  ) {
    const id = 'evt_' + randomBytes(12).toString('hex'),
      payload = JSON.stringify({
        id,
        object: 'event',
        api_version: '2026-08-26.dahlia',
        created: Math.floor(Date.now() / 1000),
        livemode: false,
        type,
        data: { object: { id: 'in_synthetic', object: 'invoice', customer } },
        ...extra,
      });
    return {
      payload,
      signature: await stripe.webhooks.generateTestHeaderStringAsync({
        payload,
        secret,
      }),
      id,
    };
  }
  return {
    transport,
    customers,
    snapshots,
    checkouts,
    event,
    loseCheckoutResponse() {
      failAfterCreate = true;
    },
    setUnavailable(value: boolean) {
      unavailable = value;
    },
  };
}
