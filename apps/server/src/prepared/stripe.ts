import Stripe from 'stripe';
import type {
  BillingTransport,
  BillingEvent,
  BillingSnapshot,
  Tier,
  Interval,
} from './billing';

export type PriceMap = Record<
  Tier,
  Record<Interval, { id: string; currency: string }>
>;
const id = (value: string | { id: string } | null | undefined) =>
  typeof value === 'string' ? value : value?.id || '';
// Deliberately test-key-only. Live enablement requires the separate launch work.
export function createStripeTransport(config: {
  secretKey: string;
  webhookSecret: string;
  prices: PriceMap;
  portalConfiguration: string;
  fetch?: typeof fetch;
}): BillingTransport {
  if (
    !/^sk_test_/.test(config.secretKey) ||
    !/^whsec_/.test(config.webhookSecret) ||
    !/^bpc_/.test(config.portalConfiguration)
  )
    throw new Error('Prepared billing requires explicit test configuration');
  const all = (['full_access', 'orchestrator'] as const).flatMap((tier) =>
    (['month', 'year'] as const).map((interval) => ({
      tier,
      interval,
      ...config.prices?.[tier]?.[interval],
    })),
  );
  if (
    all.some(
      (p) =>
        !/^price_[A-Za-z0-9]+$/.test(p.id || '') ||
        !/^[a-z]{3}$/.test(p.currency || ''),
    ) ||
    new Set(all.map((p) => p.id)).size !== 4
  )
    throw new Error('Four distinct price mappings are required');
  const stripe = new Stripe(config.secretKey, {
    apiVersion: '2026-08-26.dahlia',
    maxNetworkRetries: 0,
    timeout: 5000,
    ...(config.fetch
      ? { httpClient: Stripe.createFetchHttpClient(config.fetch) }
      : {}),
  });
  const priceFor = async (tier: Tier, interval: Interval) => {
    const mapped = config.prices[tier][interval],
      price = await stripe.prices.retrieve(mapped.id);
    if (
      price.livemode ||
      !price.active ||
      price.currency !== mapped.currency ||
      price.recurring?.interval !== interval ||
      price.recurring.interval_count !== 1 ||
      !price.unit_amount ||
      price.unit_amount <= 0
    )
      throw new Error('Price configuration mismatch');
    return price;
  };
  async function chargeForPayment(payment: Stripe.InvoicePayment) {
    if (payment.payment.type === 'charge')
      return stripe.charges.retrieve(id(payment.payment.charge));
    if (payment.payment.type === 'payment_intent') {
      const intent = await stripe.paymentIntents.retrieve(
        id(payment.payment.payment_intent),
      );
      if (intent.status !== 'succeeded' || !intent.latest_charge)
        throw new Error('Payment not settled');
      return stripe.charges.retrieve(id(intent.latest_charge));
    }
    throw new Error('Unsupported payment record');
  }
  return {
    async verify(payload, signature) {
      const event = await stripe.webhooks.constructEventAsync(
        payload,
        signature,
        config.webhookSecret,
        300,
      );
      if (event.livemode) throw new Error('Live events are refused');
      const object = event.data.object as unknown as {
        id: string;
        customer?: string | { id: string };
      };
      return {
        id: event.id,
        type: event.type,
        customerId: id(object.customer),
        objectId: object.id,
      };
    },
    async customer(userId) {
      return (
        await stripe.customers.create(
          { metadata: { linaUserId: userId } },
          { idempotencyKey: `lina-customer-${userId}` },
        )
      ).id;
    },
    async checkout(input) {
      const price = await priceFor(input.tier, input.interval);
      const session = await stripe.checkout.sessions.create(
        {
          mode: 'subscription',
          customer: input.customerId,
          line_items: [{ price: price.id, quantity: 1 }],
          payment_method_types: ['card'],
          allow_promotion_codes: false,
          expires_at: input.expiresAt,
          success_url: `${input.returnOrigin}/account/billing?checkout=returned`,
          cancel_url: `${input.returnOrigin}/account/billing?checkout=cancelled`,
        },
        { idempotencyKey: `lina-checkout-${input.key}` },
      );
      if (!session.url) throw new Error('Checkout URL missing');
      return { id: session.id, url: session.url };
    },
    async portal(customerId, origin) {
      const portal = await stripe.billingPortal.configurations.retrieve(
        config.portalConfiguration,
      );
      if (
        portal.livemode ||
        !portal.active ||
        portal.features.subscription_update.enabled ||
        !portal.features.subscription_cancel.enabled ||
        portal.features.subscription_cancel.mode !== 'at_period_end' ||
        !portal.features.payment_method_update.enabled
      )
        throw new Error('Portal configuration mismatch');
      return {
        url: (
          await stripe.billingPortal.sessions.create({
            customer: customerId,
            configuration: portal.id,
            return_url: `${origin}/account/billing`,
          })
        ).url,
      };
    },
    async resolveCustomer(event: BillingEvent) {
      if (event.customerId) return event.customerId;
      if (!event.type.startsWith('charge.dispute.'))
        throw new Error('Event customer missing');
      const dispute = await stripe.disputes.retrieve(event.objectId),
        charge = await stripe.charges.retrieve(id(dispute.charge));
      if (!charge.customer) throw new Error('Event customer missing');
      return id(charge.customer);
    },
    async snapshot(customerId): Promise<BillingSnapshot> {
      const subscriptions = await stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 100,
      });
      if (subscriptions.has_more)
        throw new Error('Subscription reconciliation exceeds limit');
      const ongoing = subscriptions.data.filter(
        (s) => !['canceled', 'incomplete_expired'].includes(s.status),
      );
      if (ongoing.length > 1)
        throw new Error('Multiple subscriptions require review');
      const sub =
        ongoing[0] ||
        subscriptions.data.sort((a, b) => b.created - a.created)[0];
      const empty: BillingSnapshot = {
        subscriptionId: sub?.id || null,
        status: sub?.status || 'none',
        tier: null,
        paidThrough: null,
        cancelAtPeriodEnd: sub?.cancel_at_period_end || false,
        held: false,
        fullyRefunded: false,
      };
      if (!sub) return empty;
      if (
        sub.livemode ||
        sub.items.has_more ||
        sub.items.data.length !== 1 ||
        sub.items.data[0].quantity !== 1
      )
        throw new Error('Unsupported subscription');
      const price = sub.items.data[0].price,
        mapped = all.find((p) => p.id === price.id);
      if (
        !mapped ||
        price.currency !== mapped.currency ||
        price.recurring?.interval !== mapped.interval ||
        price.recurring.interval_count !== 1
      )
        throw new Error('Unmapped subscription price');
      if (
        ['incomplete', 'incomplete_expired', 'trialing', 'paused'].includes(
          sub.status,
        )
      )
        return empty;
      const invoices = await stripe.invoices.list({
        customer: customerId,
        subscription: sub.id,
        status: 'paid',
        limit: 100,
      });
      // A bounded failure cannot accidentally extend access.
      if (invoices.has_more)
        throw new Error('Invoice reconciliation exceeds limit');
      for (const invoice of invoices.data.sort(
        (a, b) => b.created - a.created,
      )) {
        if (
          invoice.livemode ||
          invoice.currency !== mapped.currency ||
          invoice.amount_paid <= 0 ||
          invoice.lines.has_more
        )
          continue;
        const line = invoice.lines.data.find(
          (l) =>
            id(l.pricing?.price_details?.price) === mapped.id &&
            id(l.subscription) === sub.id,
        );
        if (
          !line ||
          line.period.end <= Date.now() / 1000 ||
          line.period.start > Date.now() / 1000
        )
          continue;
        const payments = await stripe.invoicePayments.list({
          invoice: invoice.id,
          limit: 100,
        });
        if (payments.has_more)
          throw new Error('Payment reconciliation exceeds limit');
        const paid = payments.data.filter((p) => p.status === 'paid');
        if (!paid.length)
          throw new Error('Paid invoice has no settled payment');
        let held = false,
          total = 0,
          refunded = 0;
        for (const payment of paid) {
          const charge = await chargeForPayment(payment);
          if (
            charge.livemode ||
            id(charge.customer) !== customerId ||
            !charge.paid ||
            charge.currency !== mapped.currency
          )
            throw new Error('Payment ownership mismatch');
          total += charge.amount;
          refunded += charge.amount_refunded;
          if (charge.disputed) {
            const disputes = await stripe.disputes.list({
              charge: charge.id,
              limit: 100,
            });
            if (disputes.has_more)
              throw new Error('Dispute reconciliation exceeds limit');
            held ||= disputes.data.some(
              (d) => !['won', 'warning_closed'].includes(d.status),
            );
          }
        }
        return {
          ...empty,
          tier: mapped.tier,
          paidThrough: line.period.end,
          held,
          fullyRefunded: total > 0 && refunded >= total,
        };
      }
      return empty;
    },
  };
}
