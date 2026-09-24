-- M5: deploy queue. The database is the queue: the agent claims a row with FOR UPDATE SKIP LOCKED.

ALTER TABLE deploys
  ADD COLUMN params      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- spa, php_version, sha256, size_bytes, keep
  ADD COLUMN package_key text,                                 -- the site-only zip the agent downloads
  ADD COLUMN ssl         boolean,                              -- set by the agent when it reports the result
  ADD COLUMN claimed_at  timestamptz;

CREATE INDEX deploys_queue_idx ON deploys (created_at) WHERE status = 'queued';
