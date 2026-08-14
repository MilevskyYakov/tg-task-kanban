ALTER TABLE tasks ADD COLUMN IF NOT EXISTS blocked_by_task_id uuid;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_check;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_check1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_blocked_by_same_board') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_blocked_by_same_board
      FOREIGN KEY (blocked_by_task_id, board_id) REFERENCES tasks(id, board_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_waiting_blocker_required') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_waiting_blocker_required
      CHECK (status <> 'waiting' OR num_nonnulls(blocked_by_task_id, nullif(btrim(wait_reason), '')) = 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_waiting_fields') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_waiting_fields
      CHECK (status = 'waiting' OR (blocked_by_task_id IS NULL AND wait_reason IS NULL AND wait_check_at IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_no_self_blocker') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_no_self_blocker CHECK (blocked_by_task_id IS NULL OR blocked_by_task_id <> id);
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS tasks_blocked_by ON tasks(board_id, blocked_by_task_id) WHERE blocked_by_task_id IS NOT NULL;

ALTER TABLE task_assignment_notifications ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'assignment';
ALTER TABLE task_assignment_notifications ADD COLUMN IF NOT EXISTS source_task_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_assignment_notifications_kind_check') THEN
    ALTER TABLE task_assignment_notifications ADD CONSTRAINT task_assignment_notifications_kind_check
      CHECK (kind IN ('assignment', 'unblocked'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_assignment_notifications_source_fkey') THEN
    ALTER TABLE task_assignment_notifications ADD CONSTRAINT task_assignment_notifications_source_fkey
      FOREIGN KEY (source_task_id) REFERENCES tasks(id) ON DELETE CASCADE;
  END IF;
END
$$;
CREATE UNIQUE INDEX IF NOT EXISTS task_unblock_notification_once
  ON task_assignment_notifications(task_id, assignee_user_id, source_task_id)
  WHERE kind = 'unblocked';
