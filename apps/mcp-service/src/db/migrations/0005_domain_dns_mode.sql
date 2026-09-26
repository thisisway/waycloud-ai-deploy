-- How the customer's DNS reached us: "records" (A/CNAME pointing to our target) or "ns" (nameservers delegated to Way Cloud:
-- the Plesk DNS zone appears when the site is renamed, so the agent does not wait for an A record).
ALTER TABLE domain_changes ADD COLUMN dns_mode text;
