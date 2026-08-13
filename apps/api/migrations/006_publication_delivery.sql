ALTER TABLE publication_runs ADD COLUMN IF NOT EXISTS sent_parts integer NOT NULL DEFAULT 0 CHECK (sent_parts >= 0);
