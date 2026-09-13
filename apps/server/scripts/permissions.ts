import type { Pool } from 'pg';
// Run as schema owner after every migration. Roles are provisioned separately.
export async function permissions(pool: Pool) {
  await pool.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    GRANT USAGE ON SCHEMA public TO lina_app,lina_jobs;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO lina_app;
    REVOKE INSERT,UPDATE,DELETE ON plans,schema_migrations FROM lina_app;
    REVOKE UPDATE,DELETE,TRUNCATE ON admin_audit_events FROM lina_app;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO lina_jobs;
    GRANT INSERT,UPDATE,DELETE ON activity_daily,email_outbox,job_status TO lina_jobs;
    GRANT DELETE ON activity_events,activity_dedupe,security_events,admin_audit_events,session,verification,rate_limits TO lina_jobs;
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO lina_app,lina_jobs;`);
}
