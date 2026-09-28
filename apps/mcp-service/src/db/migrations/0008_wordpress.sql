-- WordPress deploys: the .sql dump (if any) is stored separately from package_key,
-- since it must never be extracted into the public docroot.

ALTER TABLE deploys
  ADD COLUMN db_dump_key text;
