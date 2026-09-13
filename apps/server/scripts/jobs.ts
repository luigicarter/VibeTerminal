import { loadConfig } from '../src/config';
import { createPool } from '../src/db';
import { deliverEmails } from '../src/jobs/email';
import { retainAndAggregate } from '../src/jobs/retention';
import { log } from '../src/monitoring/log';
const config = loadConfig(),
  pool = createPool(config);
let closing = false,
  lastRetention = 0;
process.on('SIGINT', () => {
  closing = true;
});
process.on('SIGTERM', () => {
  closing = true;
});
try {
  do {
    for (const job of [
      'email',
      ...(Date.now() - lastRetention > 3600000 ? ['retention'] : []),
    ]) {
      try {
        const n =
          job === 'email'
            ? await deliverEmails(pool, config)
            : Number(await retainAndAggregate(pool));
        await pool.query(
          'INSERT INTO job_status(name,last_success_at,result_count) VALUES($1,now(),$2) ON CONFLICT(name) DO UPDATE SET last_success_at=now(),result_count=$2',
          [job, n],
        );
        if (job === 'retention') lastRetention = Date.now();
      } catch {
        log('error', 'job_failed');
        await pool
          .query(
            'INSERT INTO job_status(name,last_failure_at) VALUES($1,now()) ON CONFLICT(name) DO UPDATE SET last_failure_at=now()',
            [job],
          )
          .catch(() => {});
      }
    }
    if (process.argv.includes('--once')) break;
    await Bun.sleep(2000);
  } while (!closing);
} finally {
  await pool.end();
}
