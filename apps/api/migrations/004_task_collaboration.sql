CREATE UNIQUE INDEX IF NOT EXISTS tasks_id_board ON tasks(id, board_id);

CREATE TABLE IF NOT EXISTS task_comments (
  id uuid PRIMARY KEY,
  board_id uuid NOT NULL,
  task_id uuid NOT NULL,
  author_user_id bigint NOT NULL REFERENCES users(id),
  body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (task_id, board_id) REFERENCES tasks(id, board_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS task_comments_task_time ON task_comments(task_id, created_at);

CREATE TABLE IF NOT EXISTS task_checklist_items (
  id uuid PRIMARY KEY,
  board_id uuid NOT NULL,
  task_id uuid NOT NULL,
  created_by bigint NOT NULL REFERENCES users(id),
  text text NOT NULL CHECK (char_length(btrim(text)) BETWEEN 1 AND 500),
  position integer NOT NULL CHECK (position >= 0),
  completed_at timestamptz,
  completed_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (task_id, board_id) REFERENCES tasks(id, board_id) ON DELETE CASCADE,
  UNIQUE (task_id, position) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS task_attachments (
  id uuid PRIMARY KEY,
  board_id uuid NOT NULL,
  task_id uuid NOT NULL,
  added_by bigint NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('url', 'telegram')),
  url text,
  telegram_file_id text,
  telegram_file_unique_id text,
  file_name text,
  mime_type text,
  file_size bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (task_id, board_id) REFERENCES tasks(id, board_id) ON DELETE CASCADE,
  CHECK ((kind = 'url' AND url IS NOT NULL AND telegram_file_id IS NULL) OR
         (kind = 'telegram' AND url IS NULL AND telegram_file_id IS NOT NULL AND telegram_file_unique_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS task_attachments_task_time ON task_attachments(task_id, created_at);

CREATE TABLE IF NOT EXISTS task_audit_events (
  id uuid PRIMARY KEY,
  board_id uuid NOT NULL,
  task_id uuid NOT NULL,
  actor_user_id bigint NOT NULL REFERENCES users(id),
  action text NOT NULL,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (task_id, board_id) REFERENCES tasks(id, board_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS task_audit_task_time ON task_audit_events(task_id, created_at);

CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'task audit events are append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS task_audit_append_only ON task_audit_events;
CREATE TRIGGER task_audit_append_only BEFORE UPDATE OR DELETE ON task_audit_events
FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

CREATE TABLE IF NOT EXISTS task_assignment_notifications (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  assignee_user_id bigint NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
