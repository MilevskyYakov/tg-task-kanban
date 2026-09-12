ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deadline_date date;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deadline_timezone text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS create_request_id uuid;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS create_request_hash text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_deadline_shape') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_deadline_shape CHECK (
      (deadline_date IS NULL AND deadline_timezone IS NULL)
      OR (deadline IS NULL AND deadline_date IS NOT NULL AND deadline_timezone IS NOT NULL)
    );
  END IF;
END
$$;
CREATE UNIQUE INDEX IF NOT EXISTS tasks_create_request_once
  ON tasks(board_id, creator_user_id, create_request_id) WHERE create_request_id IS NOT NULL;

-- Calendar comparison handles short/long DST days without inventing an exact deadline.
CREATE OR REPLACE FUNCTION task_deadline_overdue(status text, deadline timestamptz, deadline_date date, deadline_timezone text, at_time timestamptz)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT status <> 'done' AND CASE WHEN deadline_date IS NOT NULL
    THEN (at_time AT TIME ZONE deadline_timezone)::date > deadline_date
    ELSE COALESCE(deadline < at_time, false) END;
$$;
