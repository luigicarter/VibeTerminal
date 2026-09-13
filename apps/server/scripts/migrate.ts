import { loadConfig } from '../src/config';
import { createPool } from '../src/db';
import { migrate, migrationStatus } from '../src/db/migrations';
import { permissions } from './permissions';
const config = loadConfig();
if (!config.MIGRATION_DATABASE_URL)
  throw new Error(
    'MIGRATION_DATABASE_URL is required for the migration command',
  );
const pool = createPool({
  ...config,
  DATABASE_URL: config.MIGRATION_DATABASE_URL,
});
try {
  if (process.argv.includes('--status'))
    console.log(JSON.stringify(await migrationStatus(pool)));
  else {
    await migrate(pool);
    await permissions(pool);
    console.log('Migrations applied; runtime/job permissions verified.');
  }
} catch {
  console.error(
    'Migration failed. Verify connectivity, migration checksums and database permissions.',
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
