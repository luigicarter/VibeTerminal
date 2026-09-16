import { test, expect } from 'bun:test';
import { createStripeTransport, type PriceMap } from '../src/prepared/stripe';
const prices: PriceMap = {
  full_access: {
    month: { id: 'price_fullmonth', currency: 'usd' },
    year: { id: 'price_fullyear', currency: 'usd' },
  },
  orchestrator: {
    month: { id: 'price_orchmonth', currency: 'usd' },
    year: { id: 'price_orchyear', currency: 'usd' },
  },
};
const base = {
  secretKey: 'sk_test_synthetic',
  webhookSecret: 'whsec_synthetic',
  portalConfiguration: 'bpc_synthetic',
  prices,
};
test('Stripe adapter refuses live credentials, missing prices and duplicate mappings without requests', () => {
  expect(() =>
    createStripeTransport({ ...base, secretKey: 'sk_live_not_a_real_key' }),
  ).toThrow();
  expect(() =>
    createStripeTransport({ ...base, prices: {} as PriceMap }),
  ).toThrow();
  expect(() =>
    createStripeTransport({
      ...base,
      prices: { ...prices, orchestrator: prices.full_access },
    }),
  ).toThrow();
});
test('actual SDK request serialization pins price, quantity, returns and idempotency', async () => {
  const requests: { url: string; body: string; headers: Headers }[] = [];
  const transport = createStripeTransport({
    ...base,
    fetch: (async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        body: String(init?.body || ''),
        headers: new Headers(init?.headers),
      });
      if (url.includes('/prices/'))
        return Response.json({
          id: 'price_fullmonth',
          object: 'price',
          active: true,
          livemode: false,
          currency: 'usd',
          unit_amount: 1234,
          recurring: { interval: 'month', interval_count: 1 },
        });
      if (url.endsWith('/checkout/sessions'))
        return Response.json({
          id: 'cs_test_fixture',
          object: 'checkout.session',
          url: 'https://checkout.stripe.com/c/pay/test',
        });
      throw Error('Unexpected fixture request');
    }) as typeof fetch,
  });
  await transport.checkout({
    customerId: 'cus_test',
    tier: 'full_access',
    interval: 'month',
    key: 'fixed',
    expiresAt: Math.floor(Date.now() / 1000) + 1900,
    returnOrigin: 'https://example.test',
  });
  const request = requests[1],
    body = new URLSearchParams(request.body);
  expect(request.headers.get('Idempotency-Key')).toBe('lina-checkout-fixed');
  expect(request.headers.get('Stripe-Version')).toBe('2026-08-26.dahlia');
  expect(body.get('line_items[0][price]')).toBe('price_fullmonth');
  expect(body.get('line_items[0][quantity]')).toBe('1');
  expect(body.get('allow_promotion_codes')).toBe('false');
  expect(body.get('success_url')).toBe(
    'https://example.test/account/billing?checkout=returned',
  );
  expect(body.has('subscription_data[trial_period_days]')).toBe(false);
});
test('SDK snapshots reconcile settled payment, partial/full refund, dispute and resolution from local responses', async () => {
  const now = Math.floor(Date.now() / 1000);
  let refunded = 0,
    disputed = false,
    disputeStatus = 'needs_response',
    more = false;
  const transport = createStripeTransport({
    ...base,
    fetch: (async (input) => {
      const url = new URL(String(input));
      let data: unknown;
      if (url.pathname === '/v1/subscriptions')
        data = {
          object: 'list',
          has_more: more,
          data: [
            {
              id: 'sub_test',
              object: 'subscription',
              created: now - 100,
              status: 'active',
              livemode: false,
              cancel_at_period_end: false,
              items: {
                has_more: false,
                data: [
                  {
                    quantity: 1,
                    price: {
                      id: 'price_fullmonth',
                      currency: 'usd',
                      recurring: { interval: 'month', interval_count: 1 },
                    },
                  },
                ],
              },
            },
          ],
        };
      else if (url.pathname === '/v1/invoices')
        data = {
          object: 'list',
          has_more: false,
          data: [
            {
              id: 'in_test',
              object: 'invoice',
              created: now - 100,
              livemode: false,
              currency: 'usd',
              amount_paid: 1234,
              lines: {
                has_more: false,
                data: [
                  {
                    subscription: 'sub_test',
                    pricing: { price_details: { price: 'price_fullmonth' } },
                    period: { start: now - 100, end: now + 1000 },
                  },
                ],
              },
            },
          ],
        };
      else if (url.pathname === '/v1/invoice_payments')
        data = {
          object: 'list',
          has_more: false,
          data: [
            {
              id: 'inpay_test',
              object: 'invoice_payment',
              status: 'paid',
              payment: { type: 'payment_intent', payment_intent: 'pi_test' },
            },
          ],
        };
      else if (url.pathname === '/v1/payment_intents/pi_test')
        data = {
          id: 'pi_test',
          object: 'payment_intent',
          status: 'succeeded',
          latest_charge: 'ch_test',
        };
      else if (url.pathname === '/v1/charges/ch_test')
        data = {
          id: 'ch_test',
          object: 'charge',
          customer: 'cus_test',
          paid: true,
          livemode: false,
          currency: 'usd',
          amount: 1234,
          amount_refunded: refunded,
          disputed,
        };
      else if (url.pathname === '/v1/disputes')
        data = {
          object: 'list',
          has_more: false,
          data: [{ id: 'dp_test', object: 'dispute', status: disputeStatus }],
        };
      else throw Error('Unexpected SDK request');
      return Response.json(data);
    }) as typeof fetch,
  });
  expect((await transport.snapshot('cus_test')).paidThrough).toBe(now + 1000);
  refunded = 100;
  expect((await transport.snapshot('cus_test')).fullyRefunded).toBe(false);
  refunded = 1234;
  expect((await transport.snapshot('cus_test')).fullyRefunded).toBe(true);
  refunded = 0;
  disputed = true;
  expect((await transport.snapshot('cus_test')).held).toBe(true);
  disputeStatus = 'won';
  expect((await transport.snapshot('cus_test')).held).toBe(false);
  more = true;
  await expect(transport.snapshot('cus_test')).rejects.toThrow();
});
test('portal cannot expose plan switching or immediate cancellation', async () => {
  let sessions = 0;
  const transport = createStripeTransport({
    ...base,
    fetch: (async (input) => {
      if (String(input).includes('/configurations/'))
        return Response.json({
          id: 'bpc_synthetic',
          object: 'billing_portal.configuration',
          active: true,
          livemode: false,
          features: {
            subscription_update: { enabled: true },
            subscription_cancel: { enabled: true, mode: 'at_period_end' },
            payment_method_update: { enabled: true },
          },
        });
      sessions++;
      throw Error('Unexpected portal session');
    }) as typeof fetch,
  });
  await expect(
    transport.portal('cus_test', 'https://example.test'),
  ).rejects.toThrow();
  expect(sessions).toBe(0);
});
