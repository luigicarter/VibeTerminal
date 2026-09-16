// Disposable HTTP fixture only. Not imported by either server entry point.
import { generateKeyPairSync } from 'node:crypto';
import { fixture, Client } from './helpers';
import { preparedManifest, migratePrepared } from '../src/prepared/migrations';
import { createPreparedApp } from '../src/prepared/app';
import { stripeFixture } from './prepared-fixtures';
import { bootstrapOwner } from '../src/admin/service';
const origin = process.env.LINA_PREPARED_ORIGIN || '',
  control = process.env.LINA_PREPARED_FIXTURE_TOKEN || '';
if (
  process.env.LINA_PREPARED_HTTP_FIXTURE !== '1' ||
  !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin) ||
  control.length < 32
)
  throw Error('Explicit disposable HTTP fixture configuration required');
const f = await fixture({ publicUrl: origin }),
  manifest = await preparedManifest();
await migratePrepared(f.migrationPool, manifest.root);
const pair = generateKeyPairSync('ed25519'),
  stripe = stripeFixture(),
  options = {
    migrationRoot: manifest.root,
    signer: {
      issuer: origin,
      keyId: 'fixture-v1',
      privateKey: pair.privateKey
        .export({ type: 'pkcs8', format: 'pem' })
        .toString(),
    },
    billing: stripe.transport,
  };
let service = createPreparedApp(f.config, f.pool, options);
f.service = service;
const user = await new Client(f).signup(),
  admin = await new Client(f).signup();
await bootstrapOwner(f.pool, admin.id);
await admin.login();
await admin.mfa();
const server = Bun.serve({
  hostname: '0.0.0.0',
  port: Number(new URL(origin).port),
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/_fixture/')) {
      if (request.headers.get('x-fixture-token') !== control)
        return new Response('', { status: 403 });
      if (url.pathname === '/_fixture/state')
        return Response.json({
          user: { id: user.id, email: user.email, password: user.password },
          admin: {
            id: admin.id,
            email: admin.email,
            password: admin.password,
            totpSecret: admin.totpSecret,
          },
          publicKey: pair.publicKey
            .export({ type: 'spki', format: 'pem' })
            .toString(),
        });
      if (url.pathname === '/_fixture/restart' && request.method === 'POST') {
        service = createPreparedApp(f.config, f.pool, options);
        f.service = service;
        return Response.json({ ok: true });
      }
      if (url.pathname === '/_fixture/payment' && request.method === 'POST') {
        const customer = stripe.customers.get(user.id);
        if (!customer) return new Response('', { status: 409 });
        stripe.snapshots.set(customer, {
          subscriptionId: 'sub_fixture',
          status: 'active',
          tier: 'orchestrator',
          paidThrough: Math.floor(Date.now() / 1000) + 7200,
          cancelAtPeriodEnd: false,
          held: false,
          fullyRefunded: false,
        });
        const event = await stripe.event(customer);
        await service.billing.ingest(event.payload, event.signature);
        await service.billing.work();
        return Response.json({ ok: true });
      }
      if (url.pathname === '/_fixture/suspend' && request.method === 'POST') {
        await f.pool.query(
          "UPDATE account_profiles SET status='suspended',revision=revision+1 WHERE user_id=$1",
          [user.id],
        );
        return Response.json({ ok: true });
      }
      if (url.pathname === '/_fixture/mail' && request.method === 'POST') {
        await f.mail();
        return Response.json(f.emails.map((e) => ({ to: e.to, text: e.text })));
      }
      return new Response('', { status: 404 });
    }
    if (
      url.pathname === '/account/desktop-authorization' ||
      url.pathname === '/account' ||
      url.pathname === '/account/reset'
    )
      return new Response(
        Bun.file('/fixture-web/account-prepared-harness.html'),
        {
          headers: {
            'Content-Type': 'text/html',
            'Cache-Control': 'no-store',
            'Content-Security-Policy':
              "default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self'; frame-ancestors 'none'",
            'Referrer-Policy': 'no-referrer',
          },
        },
      );
    if (/^\/assets\/[A-Za-z0-9_-]+\.js$/.test(url.pathname))
      return new Response(Bun.file('/fixture-web' + url.pathname), {
        headers: {
          'Content-Type': 'text/javascript',
          'Cache-Control': 'no-store',
        },
      });
    return service.app.fetch(request, { peerIp: '127.0.0.1' });
  },
});
console.log('Prepared HTTP fixture ready');
async function stop() {
  await server.stop(true);
  await f.close();
  await manifest.close();
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
