-- A domain bought through the page: a WHMCS domain-registration order the customer pays with the Pix on the page.
-- Once WHMCS has registered it (nameservers are Way Cloud's own) the site is pointed at it by the normal domain flow.
CREATE TABLE domain_purchases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  checkout_id text NOT NULL,                 -- the AI checkout that owns the WHMCS client
  domain      text NOT NULL,
  order_id    bigint NOT NULL,
  invoice_id  bigint NOT NULL,
  price_cents integer NOT NULL,
  status      text NOT NULL DEFAULT 'awaiting_payment',  -- awaiting_payment|registering|registered|failed|canceled
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- One purchase in progress per session, and nobody else can start the same domain meanwhile.
CREATE UNIQUE INDEX domain_purchases_open_session ON domain_purchases (session_id) WHERE status IN ('awaiting_payment', 'registering');
CREATE UNIQUE INDEX domain_purchases_open_domain ON domain_purchases (domain) WHERE status IN ('awaiting_payment', 'registering', 'registered');
