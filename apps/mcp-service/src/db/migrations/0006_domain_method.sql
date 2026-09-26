-- Which way the customer chose to point the domain (the page shows only that method's instructions).
-- "records": A/CNAME in their own DNS; "ns": nameservers delegated to Way Cloud. Either one is accepted by the DNS check.
ALTER TABLE domain_changes ADD COLUMN method text NOT NULL DEFAULT 'records';
