-- ponytail: receipts now point at any subject (task or project); FK dropped
-- until a polymorphic constraint is worth the migration. Idempotent guards included.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_name = 'mcp_write_receipts' AND column_name = 'task_id') THEN
    ALTER TABLE mcp_write_receipts RENAME COLUMN task_id TO subject_id;
  END IF;
END $$;
ALTER TABLE mcp_write_receipts DROP CONSTRAINT IF EXISTS mcp_write_receipts_task_id_fkey;
ALTER TABLE mcp_write_receipts ALTER COLUMN subject_id DROP NOT NULL;
