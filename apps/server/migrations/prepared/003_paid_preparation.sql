-- Applied only by the explicit prepared test manifest, never normal discovery.
CREATE TABLE desktop_handoffs (
  id uuid PRIMARY KEY, challenge text NOT NULL, state text NOT NULL,
  callback text NOT NULL, installation_id uuid NOT NULL,
  platform text NOT NULL CHECK(platform IN ('windows','macos','linux')),
  app_version text NOT NULL, cancel_hash text NOT NULL,
  expires_at timestamptz NOT NULL, code_hash text UNIQUE,
  code_expires_at timestamptz, user_id uuid REFERENCES "user"(id),
  browser_session_id uuid REFERENCES session(id) ON DELETE CASCADE,
  consumed_at timestamptz, cancelled_at timestamptz
);
CREATE TABLE native_sessions (
  session_id uuid PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES "user"(id), device_id uuid NOT NULL REFERENCES devices(id)
);
CREATE TABLE account_preferences (
  user_id uuid PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  share_usage boolean NOT NULL DEFAULT false
);
ALTER TABLE access_grants DROP CONSTRAINT access_grants_source_check;
ALTER TABLE access_grants ADD CONSTRAINT access_grants_source_check CHECK(source IN ('manual','beta','trial','stripe'));
ALTER TABLE access_grants ALTER COLUMN issued_by DROP NOT NULL;
ALTER TABLE access_grants ADD CONSTRAINT grants_issuer CHECK((source='stripe' AND issued_by IS NULL) OR (source<>'stripe' AND issued_by IS NOT NULL));
DROP INDEX one_administrative_grant;
CREATE UNIQUE INDEX one_administrative_grant ON access_grants(user_id) WHERE revoked_at IS NULL AND source<>'stripe';
CREATE UNIQUE INDEX one_paid_grant ON access_grants(user_id) WHERE revoked_at IS NULL AND source='stripe';
CREATE TABLE billing_accounts (
  user_id uuid PRIMARY KEY REFERENCES "user"(id), customer_id text UNIQUE,
  checkout_key uuid, checkout_id text, checkout_url text, checkout_expires_at timestamptz,
  checkout_tier text REFERENCES plans(id), checkout_interval text CHECK(checkout_interval IN ('month','year')),
  subscription_id text UNIQUE, subscription_status text,
  paid_through timestamptz, cancel_at_period_end boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE billing_inbox (
  event_id text PRIMARY KEY, customer_id text NOT NULL, event_type text NOT NULL, object_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text
);
CREATE INDEX billing_pending ON billing_inbox(next_attempt_at) WHERE processed_at IS NULL;
CREATE TABLE billing_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES "user"(id),
  event_id text, action text NOT NULL, before_state jsonb NOT NULL, after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER billing_audit_append_only BEFORE UPDATE OR DELETE ON billing_audit FOR EACH ROW EXECUTE FUNCTION protect_audit();
CREATE UNIQUE INDEX billing_audit_event ON billing_audit(event_id) WHERE event_id IS NOT NULL;
