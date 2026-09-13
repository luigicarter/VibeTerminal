import { Pool } from 'pg';
import { runPg } from './backup';
import { migrationStatus } from '../src/db/migrations';
import { permissions } from './permissions';
export async function restoreCheck(url: string, file: string) {
  const db = new Pool({ connectionString: url });
  try {
    const tables = await db.query(
      "SELECT 1 FROM pg_tables WHERE schemaname='public'",
    );
    if (tables.rowCount)
      throw new Error('Restore target must be an empty, dedicated database');
    await runPg('pg_restore', url, [
      '--no-owner',
      '--no-acl',
      '--exit-on-error',
      file,
    ]);
    if (!(await migrationStatus(db)).ready)
      throw new Error('Restored schema does not match this release');
    await permissions(db);
    return (
      await db.query(
        'SELECT (SELECT count(*) FROM "user")::int AS users,(SELECT count(*) FROM access_grants)::int AS grants,(SELECT count(*) FROM admin_audit_events)::int AS audit',
      )
    ).rows[0];
  } finally {
    await db.end();
  }
}
if (import.meta.main) {
  if (!process.env.RESTORE_DATABASE_URL || !process.argv[2])
    throw new Error(
      'Set RESTORE_DATABASE_URL to an empty database and pass a dump path',
    );
  try {
    console.log(
      JSON.stringify(
        await restoreCheck(process.env.RESTORE_DATABASE_URL, process.argv[2]),
      ),
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Restore check failed',
    );
    process.exitCode = 1;
  }
}
