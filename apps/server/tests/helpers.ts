import { Pool } from 'pg';
import { randomBytes, createHmac } from 'node:crypto';
import { createPool } from '../src/db';
import { parseConfig } from '../src/config';
import { migrate } from '../src/db/migrations';
import { permissions } from '../scripts/permissions';
import { createApp } from '../src/app';
import { deliverEmails, type Email } from '../src/jobs/email';

export async function fixture(options: { publicUrl?: string } = {}) {
  const adminUrl = process.env.LINA_TEST_ADMIN_URL;
  if (!adminUrl || process.env.LINA_TEST_ALLOW_PROVISION !== '1')
    throw new Error(
      'Run bun run test:local or configure the disposable CI PostgreSQL fixture.',
    );
  const parsed = new URL(adminUrl);
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname))
    throw new Error('Tests require loopback PostgreSQL');
  const root = new Pool({ connectionString: adminUrl }),
    name = 'lina_test_' + randomBytes(6).toString('hex');
  const passwords = Object.fromEntries(
    ['lina_migrator', 'lina_app', 'lina_jobs'].map((role) => [
      role,
      randomBytes(20).toString('hex'),
    ]),
  );
  for (const [role, pass] of Object.entries(passwords)) {
    if (
      !(await root.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]))
        .rowCount
    )
      await root.query(`CREATE ROLE ${role} LOGIN PASSWORD '${pass}'`);
    else await root.query(`ALTER ROLE ${role} PASSWORD '${pass}'`);
  }
  await root.query(`CREATE DATABASE ${name} OWNER lina_migrator`);
  const url = (role: string) => {
    const u = new URL(adminUrl);
    u.pathname = '/' + name;
    u.username = role;
    u.password = passwords[role];
    return u.href;
  };
  const config = parseConfig({
    NODE_ENV: 'test',
    DATABASE_URL: url('lina_app'),
    MIGRATION_DATABASE_URL: url('lina_migrator'),
    PUBLIC_URL: options.publicUrl || 'http://127.0.0.1:3002',
    AUTH_SECRET: randomBytes(32).toString('hex'),
    OUTBOX_KEY: randomBytes(32).toString('hex'),
    METRICS_TOKEN: randomBytes(32).toString('hex'),
    EMAIL_MODE: 'test',
    SIGNUP_ENABLED: 'true',
    USAGE_ENABLED: 'true',
  });
  const migrationPool = createPool({
    ...config,
    DATABASE_URL: url('lina_migrator'),
  });
  await migrate(migrationPool);
  await permissions(migrationPool);
  const pool = createPool(config),
    jobsPool = createPool({ ...config, DATABASE_URL: url('lina_jobs') }),
    service = createApp(config, pool),
    emails: Email[] = [];
  async function mail() {
    await deliverEmails(jobsPool, config, async (e) => {
      emails.push(e);
    });
  }
  async function close() {
    for (const [label, db] of [
      ['api', pool],
      ['jobs', jobsPool],
      ['migration', migrationPool],
    ] as const) {
      await Promise.race([
        db.end(),
        Bun.sleep(5000).then(() => {
          throw new Error(
            `Pool shutdown stalled: ${label} total=${db.totalCount} idle=${db.idleCount} waiting=${db.waitingCount}`,
          );
        }),
      ]);
    }
    await root.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await root.end();
  }
  async function availability(available: boolean) {
    await root.query(
      `ALTER DATABASE ${name} ALLOW_CONNECTIONS ${available ? 'true' : 'false'}`,
    );
    if (!available)
      await root.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1',
        [name],
      );
  }
  async function restoreTarget() {
    const target = name + '_restore';
    await root.query(`CREATE DATABASE ${target} OWNER lina_migrator`);
    const restored = new URL(url('lina_migrator'));
    restored.pathname = '/' + target;
    return {
      url: restored.href,
      drop: async () => {
        await root.query(`DROP DATABASE ${target} WITH (FORCE)`);
      },
    };
  }
  return {
    config,
    pool,
    jobsPool,
    migrationPool,
    service,
    emails,
    mail,
    close,
    name,
    availability,
    restoreTarget,
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
let peer = 0;
export class Client {
  cookies = new Map<string, string>();
  peerIp = '127.0.0.' + ++peer;
  id = '';
  email = '';
  password = 'Lina-test-password-1234!';
  totpSecret = '';
  constructor(public f: Fixture) {}
  async request(
    path: string,
    method = 'GET',
    value?: unknown,
    headers: Record<string, string> = {},
  ) {
    const response = await this.f.service.app.request(
      path,
      {
        method,
        headers: {
          origin: this.f.config.PUBLIC_URL,
          ...(value === undefined
            ? {}
            : { 'content-type': 'application/json' }),
          cookie: [...this.cookies].map(([k, v]) => k + '=' + v).join('; '),
          ...headers,
        },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      },
      { peerIp: this.peerIp },
    );
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';'),
        i = pair.indexOf('=');
      this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return response;
  }
  async json(path: string, method = 'GET', value?: unknown) {
    const r = await this.request(path, method, value);
    const data = await r.json();
    return { status: r.status, data };
  }
  async signup() {
    this.email = `user-${crypto.randomUUID()}@example.test`;
    const result = await this.json('/api/auth/sign-up/email', 'POST', {
      name: 'Test User',
      email: this.email,
      password: this.password,
    });
    if (result.status !== 200)
      throw new Error('Signup: ' + JSON.stringify(result));
    this.id = result.data.user.id;
    await this.f.mail();
    const message = this.f.emails.findLast((e) => e.to === this.email)!;
    const link = message.text.match(/http[^\s]+/)![0];
    const response = await this.request(
      new URL(link).pathname + new URL(link).search,
    );
    if (![200, 302].includes(response.status))
      throw new Error('Verify: ' + (await response.text()));
    await this.login();
    return this;
  }
  async login() {
    return this.json('/api/auth/sign-in/email', 'POST', {
      email: this.email,
      password: this.password,
    });
  }
  async mfa() {
    const enabled = await this.json('/api/auth/two-factor/enable', 'POST', {
      password: this.password,
    });
    if (enabled.status !== 200)
      throw new Error('MFA enable: ' + JSON.stringify(enabled));
    this.totpSecret = new URL(enabled.data.totpURI).searchParams.get('secret')!;
    const result = await this.json('/api/auth/two-factor/verify-totp', 'POST', {
      code: totp(this.totpSecret),
    });
    if (result.status !== 200)
      throw new Error('MFA verify: ' + JSON.stringify(result));
  }
}
export function totp(secret: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.toUpperCase().replace(/=+$/, ''))
    bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2))),
    counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac('sha1', key).update(counter).digest(),
    offset = digest[19] & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000)
    .toString()
    .padStart(6, '0');
}
