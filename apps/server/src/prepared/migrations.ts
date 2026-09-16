import { mkdtemp, copyFile, rm } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { migrationFiles, migrate } from '../db/migrations';
import { permissions } from '../../scripts/permissions';
import { serverRoot } from '../paths';

// Explicit composition only. Base SQL is copied byte-for-byte into a disposable
// manifest so checksums and readiness use the same complete migration set.
export async function preparedManifest() {
  const directory = await mkdtemp(join(tmpdir(), 'lina-prepared-manifest-'));
  const root = pathToFileURL(directory + sep);
  try {
    for (const folder of ['migrations', 'migrations/prepared']) {
      const source = join(serverRoot, folder);
      for (const file of await migrationFiles(pathToFileURL(source + sep)))
        await copyFile(join(source, file.name), join(directory, file.name));
    }
    return {
      root,
      close: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
export async function migratePrepared(pool: Pool, root: URL) {
  await migrate(pool, root);
  await permissions(pool);
  await pool.query(`REVOKE UPDATE,DELETE,TRUNCATE ON billing_audit FROM lina_app;
    GRANT INSERT,UPDATE ON billing_inbox,billing_accounts TO lina_jobs;
    GRANT INSERT ON billing_audit TO lina_jobs;
    GRANT UPDATE ON account_profiles TO lina_jobs;
    GRANT INSERT,UPDATE ON access_grants TO lina_jobs;
    GRANT DELETE ON desktop_handoffs,billing_inbox,billing_audit TO lina_jobs;`);
}
