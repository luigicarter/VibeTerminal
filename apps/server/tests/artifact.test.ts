import { test, expect } from 'bun:test';
import { fixture, Client } from './helpers';
import { resolve } from 'node:path';

test('built Bun service serves real HTTP, survives restart and drains on SIGTERM', async () => {
  const f = await fixture();
  const portProbe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = portProbe.port!;
  await portProbe.stop(true);
  const origin = 'http://127.0.0.1:' + port;
  const env = Object.fromEntries(
    Object.entries(f.config)
      .filter(([k]) => k === k.toUpperCase())
      .map(([k, v]) => [k, String(v)]),
  );
  const launch = () =>
    Bun.spawn([process.execPath, '--no-env-file', 'dist/server.js'], {
      cwd: resolve(import.meta.dir, '..'),
      env: { ...process.env, ...env, PORT: String(port), PUBLIC_URL: origin },
      stdout: 'pipe',
      stderr: 'pipe',
    });
  async function ready() {
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(origin + '/health/ready')).ok) return;
      } catch {}
      await Bun.sleep(100);
    }
    throw new Error('Built server failed readiness');
  }
  let child = launch();
  let logs = new Response(child.stdout).text(),
    errors = new Response(child.stderr).text();
  try {
    await ready();
    const user = await new Client(f).signup();
    const cookie = [...user.cookies].map(([k, v]) => k + '=' + v).join('; ');
    const times: number[] = [];
    for (let batch = 0; batch < 10; batch++)
      await Promise.all(
        Array.from({ length: 10 }, async () => {
          const start = performance.now();
          const response = await fetch(origin + '/api/v1/me', {
            headers: { cookie, origin },
          });
          expect(response.status).toBe(200);
          expect((await response.json()).user.id).toBe(user.id);
          times.push(performance.now() - start);
        }),
      );
    times.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        measurement: 'authenticated_http_100_requests_concurrency_10',
        p50Ms: Math.round(times[50]),
        p95Ms: Math.round(times[95]),
      }),
    );
    child.kill('SIGTERM');
    expect(
      await Promise.race([child.exited, Bun.sleep(12000).then(() => -1)]),
    ).toBe(0);
    const firstLogs = await logs;
    expect(firstLogs).not.toContain(user.email);
    expect(firstLogs).not.toContain(f.config.AUTH_SECRET);
    expect(firstLogs).not.toContain(cookie);
    expect(await errors).toBe('');
    child = launch();
    logs = new Response(child.stdout).text();
    errors = new Response(child.stderr).text();
    await ready();
    const response = await fetch(origin + '/api/v1/me', {
      headers: { cookie, origin },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).user.id).toBe(user.id);
    child.kill('SIGTERM');
    expect(
      await Promise.race([child.exited, Bun.sleep(12000).then(() => -1)]),
    ).toBe(0);
    await logs;
    expect(await errors).toBe('');
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
    await f.close();
  }
}, 30000);
