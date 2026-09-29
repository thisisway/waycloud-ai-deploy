-- A preview is only served after a visitor fills name + WhatsApp (once per slug, not per visitor).
ALTER TABLE previews ADD COLUMN unlocked_at timestamptz;
