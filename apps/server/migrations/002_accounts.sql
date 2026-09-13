ALTER TABLE "user" ADD CONSTRAINT user_role_check CHECK (role IN ('member','admin','owner'));
CREATE UNIQUE INDEX user_email_normalized ON "user" (lower(trim(email)));
CREATE UNIQUE INDEX account_provider_identity ON account ("providerId", "accountId");
CREATE UNIQUE INDEX two_factor_user_unique ON "twoFactor" ("userId");

CREATE TABLE account_profiles (
  user_id uuid PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended','closed')),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  approved_at timestamptz, status_changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by uuid REFERENCES "user"(id), reason text,
  last_login_at timestamptz
);
CREATE FUNCTION create_account_profile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO account_profiles(user_id) VALUES (NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER user_profile AFTER INSERT ON "user" FOR EACH ROW EXECUTE FUNCTION create_account_profile();

CREATE TABLE plans (
  id text PRIMARY KEY CHECK (id IN ('full_access','orchestrator')),
  name text NOT NULL, rank integer NOT NULL UNIQUE,
  features jsonb NOT NULL CHECK (jsonb_typeof(features)='array')
);
INSERT INTO plans VALUES
 ('full_access','Full Access',1,'["workspace","terminals","agent_modes","fusion","open_fusion","git","provider_settings"]'),
 ('orchestrator','Orchestrator',2,'["workspace","terminals","agent_modes","fusion","open_fusion","git","provider_settings","orchestrator","voice","orchestrator_history"]');
CREATE TABLE access_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES "user"(id),
  plan_id text NOT NULL REFERENCES plans(id), source text NOT NULL CHECK (source IN ('manual','beta','trial')),
  starts_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz,
  revoked_at timestamptz, issued_by uuid NOT NULL REFERENCES "user"(id),
  reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at IS NULL OR expires_at > starts_at)
);
CREATE UNIQUE INDEX one_administrative_grant ON access_grants(user_id) WHERE revoked_at IS NULL;
CREATE INDEX grants_user ON access_grants(user_id,created_at DESC);
CREATE TABLE admin_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid REFERENCES "user"(id),
  target_id uuid NOT NULL REFERENCES "user"(id), action text NOT NULL,
  before_state jsonb, after_state jsonb, reason text NOT NULL, request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_target_time ON admin_audit_events(target_id,created_at DESC);
CREATE TABLE security_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES "user"(id) ON DELETE SET NULL,
  event text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX security_user_time ON security_events(user_id,created_at DESC);
CREATE INDEX security_event_time ON security_events(event,created_at DESC);
CREATE TABLE session_factors (
  session_id uuid PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE, verified_at timestamptz NOT NULL
);
CREATE TABLE rate_limits (key text PRIMARY KEY, count integer NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES "user"(id),
  installation_id uuid NOT NULL, platform text NOT NULL CHECK(platform IN ('windows','macos','linux','ios','android','web')),
  app_version text NOT NULL, first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,installation_id), UNIQUE(id,user_id)
);
CREATE TABLE session_devices (
  session_id uuid PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES "user"(id), device_id uuid NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(device_id,user_id) REFERENCES devices(id,user_id)
);
CREATE TABLE activity_dedupe (
  user_id uuid NOT NULL REFERENCES "user"(id), event_id uuid NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT (now()+interval '35 days'), PRIMARY KEY(user_id,event_id)
);
CREATE TABLE activity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES "user"(id),
  session_id uuid, device_id uuid NOT NULL REFERENCES devices(id), event_id uuid NOT NULL,
  schema_version integer NOT NULL CHECK(schema_version=1), event text NOT NULL,
  properties jsonb NOT NULL, occurred_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_user_time ON activity_events(user_id,received_at DESC);
CREATE INDEX activity_received ON activity_events(received_at);
CREATE TABLE activity_daily (
  user_id uuid NOT NULL REFERENCES "user"(id), day date NOT NULL, event text NOT NULL,
  count integer NOT NULL CHECK(count>=0), PRIMARY KEY(user_id,day,event)
);
CREATE TABLE email_outbox (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES "user"(id), payload text,
  attempts integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz, last_error text
);
CREATE INDEX email_pending ON email_outbox(next_attempt_at) WHERE processed_at IS NULL;
CREATE TABLE job_status (name text PRIMARY KEY, last_success_at timestamptz, last_failure_at timestamptz, result_count integer);

-- Runtime code cannot amend audit history. The job role has explicit retention access.
CREATE FUNCTION protect_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'lina_jobs' AND current_user <> 'lina_migrator' THEN
    RAISE EXCEPTION 'Audit records are append only';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON admin_audit_events FOR EACH ROW EXECUTE FUNCTION protect_audit();
