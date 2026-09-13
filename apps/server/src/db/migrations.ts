import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { pathToFileURL } from 'node:url';
import { join, sep } from 'node:path';
import { serverRoot } from '../paths';
const directory = pathToFileURL(join(serverRoot, 'migrations') + sep);
export async function migrationFiles(root: URL = directory) {
  const names = (await readdir(root))
    .filter((n) => /^\d{3}_[\w-]+\.sql$/.test(n))
    .sort();
  if (!names.length) throw new Error('No migrations found');
  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(new URL(name, root), 'utf8');
      return {
        name,
        sql,
        hash: createHash('sha256').update(sql).digest('hex'),
      };
    }),
  );
}
export async function migrationStatus(pool: Pool, root?: URL) {
  const expected = await migrationFiles(root);
  const exists = await pool.query(
    "SELECT to_regclass('public.schema_migrations') AS name",
  );
  if (!exists.rows[0].name)
    return { ready: false, pending: expected.map((f) => f.name) };
  const { rows } = await pool.query(
    'SELECT name, checksum FROM schema_migrations ORDER BY name',
  );
  if (
    rows.some(
      (r) => !expected.some((f) => f.name === r.name && f.hash === r.checksum),
    )
  )
    return { ready: false, pending: ['schema_mismatch'] };
  const pending = expected
    .filter((f) => !rows.some((r) => r.name === f.name))
    .map((f) => f.name);
  return { ready: pending.length === 0, pending };
}
export async function migrate(pool: Pool, root?: URL) {
  const files = await migrationFiles(root),
    client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(82144701)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const { rows } = await client.query(
      'SELECT name, checksum FROM schema_migrations',
    );
    if (
      rows.some(
        (r) => !files.some((f) => f.name === r.name && f.hash === r.checksum),
      )
    )
      throw new Error('Applied migration checksum mismatch');
    for (const f of files.filter((f) => !rows.some((r) => r.name === f.name))) {
      await client.query('BEGIN');
      try {
        await client.query(f.sql);
        await client.query(
          'INSERT INTO schema_migrations(name, checksum) VALUES ($1,$2)',
          [f.name, f.hash],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(82144701)').catch(() => {});
    client.release();
  }
}
