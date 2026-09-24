-- Way Cloud AI Deploy: MCP service schema (Phase 1). Personal data never lives here; only ids
-- that link a session to WHMCS records.

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  text NOT NULL UNIQUE,
  ip_hash     text,
  user_agent  text,
  state       text NOT NULL DEFAULT 'active',
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);

CREATE TABLE projects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  detected_type text NOT NULL,
  analysis      jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE uploads (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  storage_key  text NOT NULL,
  sha256       text,
  size_bytes   bigint,
  source       text NOT NULL,               -- presigned | inline | cli
  scan_status  text NOT NULL DEFAULT 'pending',
  scan_report  jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE previews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  upload_id   uuid NOT NULL REFERENCES uploads(id),
  slug        text NOT NULL UNIQUE,
  url         text NOT NULL,
  status      text NOT NULL DEFAULT 'active',
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  removed_at  timestamptz
);

CREATE TABLE checkout_refs (
  session_id   uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  checkout_id  text NOT NULL,
  pid          integer NOT NULL,
  cycle        text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, checkout_id)
);

CREATE TABLE orders (
  session_id         uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  whmcs_order_id     bigint,
  whmcs_invoice_id   bigint,
  whmcs_service_id   bigint,
  status             text NOT NULL DEFAULT 'awaiting_payment',  -- awaiting_payment|paid|provisioning|active|failed
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE servers (
  id                 text PRIMARY KEY,       -- e.g. plesk-br
  label              text NOT NULL,
  agent_secret_hash  text NOT NULL,
  last_seen_at       timestamptz,
  active             boolean NOT NULL DEFAULT true
);

CREATE TABLE subscriptions (
  whmcs_service_id  bigint PRIMARY KEY,
  session_id        uuid NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  server_id         text NOT NULL REFERENCES servers(id),
  domain            text NOT NULL,
  php_version       text,
  plan_pid          integer NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE releases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id  bigint NOT NULL REFERENCES subscriptions(whmcs_service_id) ON DELETE CASCADE,
  upload_id        uuid NOT NULL REFERENCES uploads(id),
  sha256           text NOT NULL,
  is_current       boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deploys (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id  bigint NOT NULL REFERENCES subscriptions(whmcs_service_id) ON DELETE CASCADE,
  upload_id        uuid NOT NULL REFERENCES uploads(id),
  release_id       uuid REFERENCES releases(id),
  status           text NOT NULL DEFAULT 'queued',   -- queued|sending|validating|published|failed|rolled_back
  step             text,
  error_code       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz
);

CREATE TABLE verifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deploy_id     uuid NOT NULL REFERENCES deploys(id) ON DELETE CASCADE,
  http_status   integer,
  ssl_ok        boolean,
  broken_links  integer,
  ttfb_ms       integer,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE abuse_reports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  preview_id     uuid NOT NULL REFERENCES previews(id) ON DELETE CASCADE,
  reason         text NOT NULL,
  reporter_hash  text,
  status         text NOT NULL DEFAULT 'open',
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id              bigserial PRIMARY KEY,
  correlation_id  uuid,
  actor           text NOT NULL,
  action          text NOT NULL,
  meta            jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_nonces (
  nonce    text PRIMARY KEY,
  seen_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_expires_idx ON sessions (expires_at);
CREATE INDEX previews_expires_idx ON previews (expires_at) WHERE status = 'active';
CREATE INDEX deploys_sub_idx ON deploys (subscription_id, created_at DESC);
