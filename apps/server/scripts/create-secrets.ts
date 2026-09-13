import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const directory = resolve(import.meta.dir, '../data/secrets');
await mkdir(directory, { recursive: true, mode: 0o700 });
const passwords = Object.fromEntries(
  ['postgres', 'lina_migrator', 'lina_app', 'lina_jobs'].map((role) => [
    role,
    randomBytes(32).toString('hex'),
  ]),
);
const host = process.env.DATABASE_HOST || 'db',
  database = process.env.DATABASE_NAME || 'lina_accounts';
if (!/^[a-z][a-z0-9_]{0,40}$/.test(database) || !/^[a-zA-Z0-9.-]+$/.test(host))
  throw new Error('Invalid database host/name');
const values = {
  'postgres-password': passwords.postgres,
  'admin-db-url': `postgres://postgres:${passwords.postgres}@${host}:5432/postgres`,
  'migration-db-url': `postgres://lina_migrator:${passwords.lina_migrator}@${host}:5432/${database}`,
  'runtime-db-url': `postgres://lina_app:${passwords.lina_app}@${host}:5432/${database}`,
  'jobs-db-url': `postgres://lina_jobs:${passwords.lina_jobs}@${host}:5432/${database}`,
  'auth-secret': randomBytes(48).toString('base64url'),
  'outbox-key': randomBytes(32).toString('hex'),
  'metrics-token': randomBytes(48).toString('base64url'),
  'smtp-password': '',
};
// Exclusive writes: never silently rotate existing credentials.
for (const [name, value] of Object.entries(values))
  await writeFile(join(directory, name), value, { flag: 'wx', mode: 0o600 });
console.log('Created private app-owned secret files. Values were not printed.');
