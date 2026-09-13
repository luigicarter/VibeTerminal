// Maintainer tool. Generate against an EMPTY isolated DB, review SQL, never run on production.
import { writeFile, mkdir } from 'node:fs/promises';
import { getMigrations } from 'better-auth/db/migration';
import { createPool } from '../src/db';
import { createAuth } from '../src/auth';
import { parseConfig } from '../src/config';
const url = process.env.LINA_SCHEMA_DATABASE_URL;
if (!url)
  throw new Error(
    'Set LINA_SCHEMA_DATABASE_URL to an empty isolated PostgreSQL database',
  );
const config = parseConfig({
  NODE_ENV: 'test',
  DATABASE_URL: url,
  AUTH_SECRET: 'test-auth-secret-not-for-production-12345',
  OUTBOX_KEY: '1'.repeat(64),
  METRICS_TOKEN: 'test-metrics-not-for-production-12345',
  EMAIL_MODE: 'test',
});
const pool = createPool(config);
try {
  if (
    (await pool.query("SELECT 1 FROM pg_tables WHERE schemaname='public'"))
      .rowCount
  )
    throw new Error('Schema generation requires an empty isolated database');
  const auth = createAuth(config, pool);
  const plan = await getMigrations(auth.options);
  await mkdir(new URL('../.tmp/', import.meta.url), { recursive: true });
  await writeFile(
    new URL('../.tmp/generated-auth.sql', import.meta.url),
    await plan.compileMigrations(),
  );
  console.log(
    'Auth schema written to .tmp/generated-auth.sql for review. Existing migrations were not changed.',
  );
} finally {
  await pool.end();
}
