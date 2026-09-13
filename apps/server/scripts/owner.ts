import { loadConfig } from '../src/config';
import { createPool } from '../src/db';
import { bootstrapOwner } from '../src/admin/service';
import { uuid } from '../src/http';
const id = uuid(process.argv[2] || ''),
  pool = createPool(loadConfig());
try {
  await bootstrapOwner(pool, id);
  console.log(
    'Owner created. Sign in again and enroll MFA before administration.',
  );
} catch {
  console.error(
    'Owner bootstrap failed: verify the user and ensure no owner exists.',
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
