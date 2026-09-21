ALTER TABLE task_attachments DROP CONSTRAINT IF EXISTS task_attachments_kind_check;
ALTER TABLE task_attachments DROP CONSTRAINT IF EXISTS task_attachments_check;
ALTER TABLE task_attachments ADD COLUMN IF NOT EXISTS file_data bytea;
ALTER TABLE task_attachments ADD CONSTRAINT task_attachments_kind_check CHECK (kind IN ('url', 'telegram', 'file'));
ALTER TABLE task_attachments ADD CONSTRAINT task_attachments_check CHECK (
  (kind = 'url' AND url IS NOT NULL AND telegram_file_id IS NULL AND file_data IS NULL) OR
  (kind = 'telegram' AND url IS NULL AND telegram_file_id IS NOT NULL AND telegram_file_unique_id IS NOT NULL AND file_data IS NULL) OR
  (kind = 'file' AND url IS NULL AND telegram_file_id IS NULL AND file_data IS NOT NULL));
