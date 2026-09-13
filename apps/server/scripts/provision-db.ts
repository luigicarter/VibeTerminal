import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { loadConfig } from '../src/config';
const config = loadConfig();
function secret(name: string) {
  const file = process.env[name + '_FILE'];
  return file ? readFileSync(file, 'utf8').trim() : process.env[name] || '';
}
const admin = new Pool({ connectionString: secret('DATABASE_ADMIN_URL') });
try {
  const connections = {
    lina_migrator: config.MIGRATION_DATABASE_URL!,
    lina_app: config.DATABASE_URL,
    lina_jobs: secret('JOBS_DATABASE_URL'),
  };
  const urls = Object.values(connections).map((u) => new URL(u)),
    dbName = urls[0].pathname.slice(1);
  if (
    !/^[a-z][a-z0-9_]{0,40}$/.test(dbName) ||
    urls.some((u) => u.pathname !== '/' + dbName || u.host !== urls[0].host)
  )
    throw new Error(
      'Database URLs must share the intended server and database',
    );
  for (const [role, connection] of Object.entries(connections)) {
    const url = new URL(connection),
      pass = decodeURIComponent(url.password);
    if (url.username !== role || !/^[a-f0-9]{64}$/.test(pass))
      throw new Error('Use generated role-specific credentials');
    if (
      !(await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]))
        .rowCount
    )
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${pass}'`);
  }
  const exists = await admin.query(
    'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1',
    [dbName],
  );
  if (!exists.rowCount)
    await admin.query(`CREATE DATABASE ${dbName} OWNER lina_migrator`);
  else if (exists.rows[0].owner !== 'lina_migrator')
    throw new Error('Existing database has another owner');
  for (const connection of Object.values(connections)) {
    const check = new Pool({ connectionString: connection });
    try {
      await check.query('SELECT 1');
    } finally {
      await check.end();
    }
  }
  console.log(
    'Database and isolated roles provisioned; existing credentials were not rotated.',
  );
} catch {
  console.error(
    'Provisioning failed; verify generated secrets, target database ownership and administrator access.',
  );
  process.exitCode = 1;
} finally {
  await admin.end();
}
