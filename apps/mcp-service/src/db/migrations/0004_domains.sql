-- The customer's own domain replaces the provisional one (<slug>.sites.waypreview.com.br).
-- One row per request: it waits for the customer's DNS, then the deploy agent switches the site on the Plesk server.
CREATE TABLE domain_changes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id  bigint NOT NULL REFERENCES subscriptions(whmcs_service_id) ON DELETE CASCADE,
  domain           text NOT NULL,
  status           text NOT NULL DEFAULT 'waiting_dns',   -- waiting_dns|ready|switching|active|failed|expired|cancelled
  include_www      boolean NOT NULL DEFAULT false,         -- www.<domain> already points to us: ask for its certificate too
  old_domain       text,                                   -- the provisional domain, kept once the switch is claimed
  ssl              boolean,
  step             text,
  error_code       text,
  attempts         integer NOT NULL DEFAULT 0,             -- DNS checks so far (drives the backoff)
  next_check_at    timestamptz NOT NULL DEFAULT now(),
  whmcs_synced     boolean NOT NULL DEFAULT false,         -- WHMCS knows the new domain (its Plesk module finds the site by it)
  claimed_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- One open request per subscription, and a domain can only be in play once.
CREATE UNIQUE INDEX domain_changes_open ON domain_changes (subscription_id) WHERE status IN ('waiting_dns', 'ready', 'switching');
CREATE UNIQUE INDEX domain_changes_live ON domain_changes (domain) WHERE status IN ('waiting_dns', 'ready', 'switching', 'active');
CREATE INDEX domain_changes_due ON domain_changes (next_check_at) WHERE status = 'waiting_dns';
