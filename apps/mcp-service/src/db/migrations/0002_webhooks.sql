-- M4: idempotent processing of WHMCS webhooks and the order facts the service needs.

CREATE TABLE webhook_events (
  whmcs_event_id  bigint PRIMARY KEY,           -- id of the addon's outbox row: retries carry the same id
  event           text NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE orders
  ADD COLUMN checkout_id text,
  ADD COLUMN plan_pid    integer,
  ADD COLUMN cycle       text;
