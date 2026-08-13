CREATE TABLE IF NOT EXISTS recurrence_templates (
  id uuid PRIMARY KEY,
  board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  creator_user_id bigint NOT NULL REFERENCES users(id),
  project_id uuid,
  assignee_user_id bigint,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description text,
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'urgent')),
  frequency text NOT NULL CHECK (frequency IN ('daily', 'weekdays', 'weekly', 'monthly')),
  weekdays smallint[],
  day_of_month smallint CHECK (day_of_month BETWEEN 1 AND 31),
  local_time time NOT NULL,
  timezone text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  next_occurrence_at timestamptz,
  paused_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (frequency <> 'weekdays' OR cardinality(weekdays) > 0),
  CHECK (frequency <> 'monthly' OR day_of_month IS NOT NULL),
  CHECK (ends_at IS NULL OR ends_at >= starts_at),
  FOREIGN KEY (project_id, board_id) REFERENCES projects(id, board_id),
  FOREIGN KEY (board_id, assignee_user_id) REFERENCES memberships(board_id, user_id)
);
CREATE INDEX IF NOT EXISTS recurrence_due ON recurrence_templates(next_occurrence_at)
  WHERE paused_at IS NULL AND archived_at IS NULL AND next_occurrence_at IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS recurrence_templates_id_board ON recurrence_templates(id, board_id);

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS recurrence_template_id uuid,
  ADD COLUMN IF NOT EXISTS occurrence_at timestamptz;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_recurrence_template_board_fk;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_recurrence_occurrence_pair;
ALTER TABLE tasks
  ADD CONSTRAINT tasks_recurrence_template_board_fk FOREIGN KEY (recurrence_template_id, board_id)
    REFERENCES recurrence_templates(id, board_id),
  ADD CONSTRAINT tasks_recurrence_occurrence_pair CHECK ((recurrence_template_id IS NULL) = (occurrence_at IS NULL));
CREATE UNIQUE INDEX IF NOT EXISTS tasks_recurrence_occurrence ON tasks(recurrence_template_id, occurrence_at);

CREATE OR REPLACE FUNCTION clear_assignments_on_membership_delete() RETURNS trigger AS $$
BEGIN
  UPDATE tasks SET assignee_user_id = NULL, updated_at = now()
  WHERE board_id = OLD.board_id AND assignee_user_id = OLD.user_id;
  UPDATE recurrence_templates SET assignee_user_id = NULL, updated_at = now()
  WHERE board_id = OLD.board_id AND assignee_user_id = OLD.user_id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
