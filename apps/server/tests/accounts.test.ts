import { beforeAll, afterAll, describe, test, expect } from 'bun:test';
import { fixture, Client, type Fixture } from './helpers';
import { bootstrapOwner } from '../src/admin/service';
import { accessFor } from '../src/access';
import { migrate, migrationStatus } from '../src/db/migrations';
import { retainAndAggregate } from '../src/jobs/retention';
import { randomUUID } from 'node:crypto';
import { createPool } from '../src/db';
import { createApp } from '../src/app';
import { parseConfig } from '../src/config';
import { backupDatabase } from '../scripts/backup';
import { restoreCheck } from '../scripts/restore-check';
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { queueEmail, deliverEmails } from '../src/jobs/email';
let f: Fixture, owner: Client, alice: Client, bob: Client;
beforeAll(async () => {
  f = await fixture();
  owner = await new Client(f).signup();
  await bootstrapOwner(f.pool, owner.id);
  await owner.login();
  await owner.mfa();
  alice = await new Client(f).signup();
  bob = await new Client(f).signup();
});
afterAll(async () => {
  await f?.close();
});
const change = (id: string, action: string, value: unknown, method = 'POST') =>
  owner.json(`/api/v1/admin/users/${id}/${action}`, method, value);
describe('database and login', () => {
  test('real database is ready; migrations repeat and serialize', async () => {
    expect((await owner.json('/health/ready')).status).toBe(200);
    await Promise.all([migrate(f.migrationPool), migrate(f.migrationPool)]);
    expect((await migrationStatus(f.pool)).ready).toBe(true);
  });
  test('runtime cannot create schema or change seeded plans', async () => {
    await expect(
      f.pool.query('CREATE TABLE forbidden(id int)'),
    ).rejects.toThrow();
    await expect(
      f.pool.query("UPDATE plans SET name='wrong'"),
    ).rejects.toThrow();
  });
  test('pending verified account has no product grant', async () => {
    const result = await alice.json('/api/v1/me');
    expect(result.data.user.emailVerified).toBe(true);
    expect(result.data.access.reason).toBe('account_pending');
    expect(result.data.access.tier).toBeNull();
  });
  test('signup rejects client privileges', async () => {
    const result = await new Client(f).json('/api/auth/sign-up/email', 'POST', {
      email: 'rogue@example.test',
      name: 'Rogue',
      password: 'Valid-password-123!',
      role: 'owner',
    });
    expect(result.status).toBe(400);
  });
  test('wrong password fails and creates safe security event', async () => {
    expect(
      (
        await alice.json('/api/auth/sign-in/email', 'POST', {
          email: alice.email,
          password: 'Wrong-password-123',
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int AS n FROM security_events WHERE event='login_failed'",
        )
      ).rows[0].n,
    ).toBeGreaterThan(0);
  });
  test('own session responses never include tokens', async () => {
    const result = await alice.json('/api/v1/me/sessions');
    expect(result.status).toBe(200);
    expect(JSON.stringify(result.data)).not.toContain('token');
    expect(result.data.sessions.length).toBeGreaterThan(0);
  });
  test('cross-user session revocation fails', async () => {
    const sessions = await bob.json('/api/v1/me/sessions');
    expect(
      (
        await alice.json(
          '/api/v1/me/sessions/' + sessions.data.sessions[0].id,
          'DELETE',
        )
      ).status,
    ).toBe(404);
  });
  test('member cannot read or mutate admin API', async () => {
    expect((await alice.json('/api/v1/admin/users')).status).toBe(403);
    expect(
      (
        await alice.json(
          '/api/v1/admin/users/' + alice.id + '/approve',
          'POST',
          {
            expectedRevision: 0,
            reason: 'Privilege attack',
            tier: 'orchestrator',
          },
        )
      ).status,
    ).toBe(403);
  });
  test('MFA enrollment creates session-bound verification', async () => {
    expect((await owner.json('/api/v1/admin/users')).status).toBe(200);
    const result = await f.pool.query('SELECT * FROM session_factors');
    expect(result.rowCount).toBeGreaterThan(0);
  });
  test('owner cannot be bootstrapped twice', async () => {
    await expect(bootstrapOwner(f.pool, bob.id)).rejects.toThrow();
  });
  test('last owner cannot be suspended or demoted', async () => {
    const revision = (await owner.json('/api/v1/me')).data.access.revision;
    expect(
      (
        await change(
          owner.id,
          'status',
          {
            expectedRevision: revision,
            reason: 'Last owner guard',
            status: 'suspended',
          },
          'PATCH',
        )
      ).data.error.code,
    ).toBe('last_owner');
    expect(
      (
        await change(
          owner.id,
          'role',
          {
            expectedRevision: revision,
            reason: 'Last owner guard',
            role: 'member',
          },
          'PATCH',
        )
      ).data.error.code,
    ).toBe('last_owner');
  });
});
describe('tiers and activity', () => {
  test('owner approves Full Access and Orchestrator atomically', async () => {
    expect(
      (
        await change(alice.id, 'approve', {
          expectedRevision: 0,
          reason: 'Approve first tester',
          tier: 'full_access',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await change(bob.id, 'approve', {
          expectedRevision: 0,
          reason: 'Approve second tester',
          tier: 'orchestrator',
        })
      ).status,
    ).toBe(200);
    expect((await accessFor(f.pool, alice.id)).features).not.toContain(
      'orchestrator',
    );
    expect((await accessFor(f.pool, bob.id)).features).toContain(
      'orchestrator',
    );
  });
  test('concurrent stale assignments cannot overwrite each other', async () => {
    const results = await Promise.all([
      change(
        alice.id,
        'access',
        { expectedRevision: 1, reason: 'Change tier A', tier: 'orchestrator' },
        'PUT',
      ),
      change(
        alice.id,
        'access',
        { expectedRevision: 1, reason: 'Change tier B', tier: 'full_access' },
        'PUT',
      ),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });
  test('audit is append only for the runtime role', async () => {
    await expect(
      f.pool.query('DELETE FROM admin_audit_events WHERE target_id=$1', [
        alice.id,
      ]),
    ).rejects.toThrow();
    const audit = await owner.json('/api/v1/admin/audit');
    expect(audit.data.events.length).toBeGreaterThan(2);
  });
  test('device ownership, event deduplication and strict privacy schema', async () => {
    const device = (
      await alice.json('/api/v1/devices/register', 'POST', {
        installationId: randomUUID(),
        platform: 'windows',
        appVersion: '0.1.117',
      })
    ).data.deviceId;
    expect(device).toBeTruthy();
    expect(
      (
        await alice.json('/api/v1/activity/heartbeat', 'POST', {
          deviceId: device,
        })
      ).status,
    ).toBe(200);
    const event = {
      deviceId: device,
      events: [
        {
          eventId: randomUUID(),
          schemaVersion: 1,
          event: 'terminal.started',
          occurredAt: new Date().toISOString(),
          properties: {},
        },
      ],
    };
    expect(
      (await alice.json('/api/v1/activity/events', 'POST', event)).data
        .accepted,
    ).toBe(1);
    expect(
      (await alice.json('/api/v1/activity/events', 'POST', event)).data
        .duplicates,
    ).toBe(1);
    expect(
      (await bob.json('/api/v1/activity/events', 'POST', event)).status,
    ).toBe(403);
    expect(
      (
        await alice.json('/api/v1/activity/events', 'POST', {
          ...event,
          userId: bob.id,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await alice.json('/api/v1/activity/events', 'POST', {
          ...event,
          events: [{ ...event.events[0], properties: { prompt: 'private' } }],
        })
      ).status,
    ).toBe(400);
  });
  test('presence becomes stale without revoking access', async () => {
    await f.migrationPool.query(
      "UPDATE session_devices SET last_seen_at=now()-interval '4 minutes' WHERE user_id=$1",
      [alice.id],
    );
    const result = await alice.json('/api/v1/me/sessions');
    expect(
      result.data.sessions.find((s: any) => s.device_id).recently_seen,
    ).toBe(false);
    expect((await accessFor(f.pool, alice.id)).allowed).toBe(true);
  });
  test('suspension denies product activity but preserves own status', async () => {
    const rev = (await accessFor(f.pool, alice.id)).revision;
    expect(
      (
        await change(
          alice.id,
          'status',
          {
            expectedRevision: rev,
            reason: 'Suspend test access',
            status: 'suspended',
          },
          'PATCH',
        )
      ).status,
    ).toBe(200);
    expect((await alice.json('/api/v1/me')).data.access.reason).toBe(
      'account_suspended',
    );
    expect(
      (
        await alice.json('/api/v1/activity/heartbeat', 'POST', {
          deviceId: randomUUID(),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await change(
          alice.id,
          'status',
          {
            expectedRevision: rev + 1,
            reason: 'Reactivate test access',
            status: 'active',
          },
          'PATCH',
        )
      ).status,
    ).toBe(200);
  });
  test('expiry denies access even while identity remains valid', async () => {
    await f.migrationPool.query(
      "UPDATE access_grants SET starts_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE user_id=$1 AND revoked_at IS NULL",
      [alice.id],
    );
    expect((await alice.json('/api/v1/me/access')).data.reason).toBe(
      'access_expired',
    );
  });
  test('metrics requires separate credentials', async () => {
    expect((await alice.json('/internal/metrics')).status).toBe(401);
    const result = await alice.request('/internal/metrics', 'GET', undefined, {
      authorization: 'Bearer ' + f.config.METRICS_TOKEN,
    });
    expect(result.status).toBe(200);
    expect(await result.text()).toContain('lina_db_pool_total');
  });
  test('origin and payload size guards apply before mutations', async () => {
    expect(
      (
        await alice.request(
          '/api/v1/activity/heartbeat',
          'POST',
          {},
          { origin: 'https://evil.example' },
        )
      ).status,
    ).toBe(403);
    const r = await alice.request('/api/auth/sign-in/email', 'POST', {
      padding: 'x'.repeat(40000),
    });
    expect(r.status).toBe(413);
  });
  test('retention and summaries are repeatable', async () => {
    await f.migrationPool.query(
      "UPDATE activity_events SET received_at=now()-interval '1 day'",
    );
    await retainAndAggregate(f.jobsPool);
    await retainAndAggregate(f.jobsPool);
    const rows = await f.pool.query(
      'SELECT count FROM activity_daily WHERE user_id=$1',
      [alice.id],
    );
    expect(rows.rows[0].count).toBe(1);
  });
  test('revocation invalidates existing sessions online', async () => {
    const rev = (await accessFor(f.pool, bob.id)).revision;
    expect(
      (
        await change(bob.id, 'revoke-sessions', {
          expectedRevision: rev,
          reason: 'Revoke lost device sessions',
        })
      ).status,
    ).toBe(200);
    expect((await bob.json('/api/v1/me')).status).toBe(401);
  });
});

describe('recovery and release behavior', () => {
  test('readiness stays false until an empty database is migrated', async () => {
    const target = await f.restoreTarget(),
      db = createPool({ ...f.config, DATABASE_URL: target.url });
    try {
      const service = createApp({ ...f.config, DATABASE_URL: target.url }, db);
      expect((await service.app.request('/health/ready')).status).toBe(503);
      expect((await service.app.request('/health/live')).status).toBe(200);
      await migrate(db);
      expect((await service.app.request('/health/ready')).status).toBe(200);
    } finally {
      await db.end();
      await target.drop();
    }
  });
  test('MFA freshness expires before another administrator mutation', async () => {
    await f.migrationPool.query(
      'UPDATE session_factors SET verified_at=now()-interval \'6 minutes\' WHERE session_id IN (SELECT id FROM session WHERE "userId"=$1)',
      [owner.id],
    );
    try {
      const result = await change(bob.id, 'revoke-access', {
        expectedRevision: 0,
        reason: 'Fresh MFA required',
      });
      expect(result.status).toBe(403);
      expect(result.data.error.code).toBe('recent_login_required');
    } finally {
      await f.migrationPool.query(
        'UPDATE session_factors SET verified_at=now() WHERE session_id IN (SELECT id FROM session WHERE "userId"=$1)',
        [owner.id],
      );
    }
  });
  test('failed email delivery retries without logging plaintext and expiry clears payload', async () => {
    await queueEmail(
      f.pool,
      f.config,
      alice.id,
      alice.email,
      'verify',
      'https://example.test/verify?token=PRIVATE_FIXTURE_TOKEN',
      3600,
    );
    const record = (
      await f.pool.query(
        'SELECT * FROM email_outbox WHERE processed_at IS NULL ORDER BY created_at DESC LIMIT 1',
      )
    ).rows[0];
    expect(record.payload).not.toContain('PRIVATE_FIXTURE_TOKEN');
    expect(record.payload).not.toContain(alice.email);
    await deliverEmails(f.jobsPool, f.config, async () => {
      throw new Error('Private SMTP error details');
    });
    const failed = (
      await f.pool.query('SELECT * FROM email_outbox WHERE id=$1', [record.id])
    ).rows[0];
    expect(failed.last_error).toBe('delivery_failed');
    expect(failed.attempts).toBe(1);
    expect(failed.processed_at).toBeNull();
    await f.migrationPool.query(
      "UPDATE email_outbox SET expires_at=now()-interval '1 second' WHERE id=$1",
      [record.id],
    );
    await deliverEmails(f.jobsPool, f.config, async () => {
      throw new Error('Expired email must not be delivered');
    });
    const expired = (
      await f.pool.query('SELECT * FROM email_outbox WHERE id=$1', [record.id])
    ).rows[0];
    expect(expired.last_error).toBe('expired');
    expect(expired.payload).toBeNull();
  });
  test('unverified login cannot bypass verification', async () => {
    const client = new Client(f);
    client.email = 'unverified-' + randomUUID() + '@example.test';
    expect(
      (
        await client.json('/api/auth/sign-up/email', 'POST', {
          name: 'Unverified',
          email: client.email,
          password: client.password,
        })
      ).status,
    ).toBe(200);
    expect((await client.login()).status).toBe(403);
    expect((await client.json('/api/v1/me')).status).toBe(401);
  });
  test('password recovery is generic, single use, and revokes old sessions', async () => {
    const client = await new Client(f).signup(),
      known = await client.json('/api/auth/request-password-reset', 'POST', {
        email: client.email,
        redirectTo: f.config.PUBLIC_URL + '/reset',
      });
    const unknown = await client.json(
      '/api/auth/request-password-reset',
      'POST',
      {
        email: 'missing-' + randomUUID() + '@example.test',
        redirectTo: f.config.PUBLIC_URL + '/reset',
      },
    );
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.data).toEqual(unknown.data);
    await f.mail();
    const email = f.emails.findLast(
      (e) => e.to === client.email && e.subject.includes('Reset'),
    )!;
    expect(email).toBeDefined();
    const link = new URL(email.text.match(/http[^\s]+/)![0]),
      token = link.pathname.split('/').at(-1)!;
    const newPassword = 'New-Lina-password-123!';
    expect(
      (
        await client.json('/api/auth/reset-password', 'POST', {
          token,
          newPassword,
        })
      ).status,
    ).toBe(200);
    expect((await client.json('/api/v1/me')).status).toBe(401);
    expect(
      (
        await client.json('/api/auth/reset-password', 'POST', {
          token,
          newPassword,
        })
      ).status,
    ).toBe(400);
    client.password = newPassword;
    expect((await client.login()).status).toBe(200);
  });
  test('expired recovery token is refused', async () => {
    const client = await new Client(f).signup();
    await client.json('/api/auth/request-password-reset', 'POST', {
      email: client.email,
    });
    await f.mail();
    const email = f.emails.findLast(
      (e) => e.to === client.email && e.subject.includes('Reset'),
    )!;
    const token = new URL(email.text.match(/http[^\s]+/)![0]).pathname
      .split('/')
      .at(-1)!;
    await f.migrationPool.query(
      'UPDATE verification SET "expiresAt"=now()-interval \'1 minute\' WHERE identifier=$1',
      ['reset-password:' + token],
    );
    expect(
      (
        await client.json('/api/auth/reset-password', 'POST', {
          token,
          newPassword: 'New-Lina-password-123!',
        })
      ).status,
    ).toBe(400);
  });
  test('privileged role without MFA evidence cannot administer', async () => {
    const client = await new Client(f).signup();
    await f.migrationPool.query(
      'UPDATE "user" SET role=\'admin\' WHERE id=$1',
      [client.id],
    );
    await f.migrationPool.query(
      "UPDATE account_profiles SET status='active' WHERE user_id=$1",
      [client.id],
    );
    expect((await client.json('/api/v1/admin/users')).data.error.code).toBe(
      'mfa_required',
    );
  });
  test('unknown auth plugin routes cannot bypass the custom admin layer', async () => {
    expect(
      (
        await owner.json('/api/auth/admin/set-role', 'POST', {
          userId: alice.id,
          role: 'owner',
        })
      ).status,
    ).toBe(404);
    expect((await owner.json('/api/auth/list-sessions')).status).toBe(404);
  });
  test('logout invalidates the current session and records a server event', async () => {
    const client = await new Client(f).signup();
    expect((await client.json('/api/auth/sign-out', 'POST', {})).status).toBe(
      200,
    );
    expect((await client.json('/api/v1/me')).status).toBe(401);
    expect(
      (
        await f.pool.query(
          "SELECT 1 FROM security_events WHERE user_id=$1 AND event='logged_out'",
          [client.id],
        )
      ).rowCount,
    ).toBe(1);
  });
  test('MFA attempts are limited per account across source IPs', async () => {
    const client = await new Client(f).signup();
    await client.mfa();
    let result;
    for (let i = 0; i < 10; i++) {
      client.peerIp = '127.1.0.' + i;
      result = await client.json('/api/auth/two-factor/verify-totp', 'POST', {
        code: 'invalid',
      });
    }
    expect(result!.status).toBe(429);
    expect(result!.data.error.code).toBe('factor_rate_limited');
  });
  test('forwarded header spoofing cannot reset IP limits', async () => {
    const client = new Client(f);
    let status = 0;
    for (let i = 0; i < 41; i++)
      status = (
        await client.request('/api/auth/get-session', 'GET', undefined, {
          'x-real-ip': '10.0.0.' + i,
        })
      ).status;
    expect(status).toBe(429);
  });
  test('configuration rejects insecure production and never echoes values', () => {
    expect(() =>
      parseConfig({
        ...f.config,
        NODE_ENV: 'production',
        PUBLIC_URL: 'http://bad.example',
        SIGNUP_ENABLED: 'true',
        USAGE_ENABLED: 'true',
      }),
    ).toThrow();
    try {
      parseConfig({ DATABASE_URL: 'SENSITIVE_VALUE' });
    } catch (error) {
      expect(String(error)).not.toContain('SENSITIVE_VALUE');
    }
  });
  test('unknown grants, invalid expiry, duplicates and foreign keys are rejected', async () => {
    await expect(
      f.migrationPool.query(
        "INSERT INTO access_grants(user_id,plan_id,source,issued_by,reason) VALUES($1,'free','manual',$2,'Invalid plan')",
        [bob.id, owner.id],
      ),
    ).rejects.toThrow();
    await expect(
      f.migrationPool.query(
        'INSERT INTO account_profiles(user_id) VALUES($1)',
        [randomUUID()],
      ),
    ).rejects.toThrow();
    await expect(
      f.migrationPool.query(
        'INSERT INTO account_profiles(user_id) VALUES($1)',
        [alice.id],
      ),
    ).rejects.toThrow();
  });
  test('failed migrations roll back and checksum edits are rejected', async () => {
    const directory = await mkdtemp(
      resolve(import.meta.dir, '../.tmp/migration-'),
    );
    const root = pathToFileURL(directory + sep),
      connection = new URL(f.config.MIGRATION_DATABASE_URL!);
    const target = await f.restoreTarget();
    const db = createPool({ ...f.config, DATABASE_URL: target.url });
    try {
      await writeFile(
        new URL('001_test.sql', root),
        'CREATE TABLE transaction_fixture(id int); SELECT missing_function();',
      );
      await expect(migrate(db, root)).rejects.toThrow();
      expect(
        (
          await db.query(
            "SELECT to_regclass('public.transaction_fixture') AS name",
          )
        ).rows[0].name,
      ).toBeNull();
      await writeFile(
        new URL('001_test.sql', root),
        'CREATE TABLE transaction_fixture(id int);',
      );
      await migrate(db, root);
      await writeFile(
        new URL('001_test.sql', root),
        'CREATE TABLE changed_fixture(id int);',
      );
      await expect(migrate(db, root)).rejects.toThrow();
    } finally {
      await db.end();
      await target.drop();
    }
  });
  test('usage can be disabled independently of authentication', async () => {
    await bob.login();
    const service = createApp({ ...f.config, USAGE_ENABLED: false }, f.pool);
    const response = await service.app.request(
      '/api/v1/activity/events',
      {
        method: 'POST',
        headers: {
          origin: f.config.PUBLIC_URL,
          'content-type': 'application/json',
          cookie: [...bob.cookies].map(([k, v]) => k + '=' + v).join('; '),
        },
        body: '{}',
      },
      { peerIp: '127.0.1.1' },
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe(
      'usage_collection_disabled',
    );
    expect((await bob.json('/api/v1/me')).status).toBe(200);
  });
  test('database outage changes readiness and recovers without granting access', async () => {
    await f.availability(false);
    try {
      expect((await owner.json('/health/live')).status).toBe(200);
      expect((await owner.json('/health/ready')).status).toBe(503);
      expect((await alice.json('/api/v1/me')).status).toBe(503);
    } finally {
      await f.availability(true);
    }
    expect((await owner.json('/health/ready')).status).toBe(200);
    expect((await alice.json('/api/v1/me')).status).toBe(200);
  });
  test('real PostgreSQL dump restores accounts, grants and audit into a clean database', async () => {
    const before = (
      await f.pool.query(
        'SELECT (SELECT count(*) FROM "user")::int AS users,(SELECT count(*) FROM access_grants)::int AS grants,(SELECT count(*) FROM admin_audit_events)::int AS audit',
      )
    ).rows[0];
    const file = await backupDatabase(
      f.config.MIGRATION_DATABASE_URL!,
      resolve(import.meta.dir, '../.tmp/backups'),
    );
    const target = await f.restoreTarget();
    try {
      expect(await restoreCheck(target.url, file)).toEqual(before);
      await expect(restoreCheck(target.url, file)).rejects.toThrow('empty');
    } finally {
      await target.drop();
    }
  });
});
