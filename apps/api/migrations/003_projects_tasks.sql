CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY,
  board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  created_by bigint NOT NULL REFERENCES users(id),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_board_active ON projects(board_id) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS projects_id_board ON projects(id, board_id);

CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY,
  board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  project_id uuid,
  creator_user_id bigint NOT NULL REFERENCES users(id),
  assignee_user_id bigint REFERENCES users(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description text,
  status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'waiting', 'done')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'urgent')),
  deadline timestamptz,
  wait_reason text,
  wait_check_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'waiting' OR nullif(btrim(wait_reason), '') IS NOT NULL),
  CHECK (status = 'waiting' OR (wait_reason IS NULL AND wait_check_at IS NULL)),
  FOREIGN KEY (project_id, board_id) REFERENCES projects(id, board_id),
  FOREIGN KEY (board_id, assignee_user_id) REFERENCES memberships(board_id, user_id)
);
CREATE INDEX IF NOT EXISTS tasks_board_active ON tasks(board_id, status) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS tasks_assignee_active ON tasks(assignee_user_id) WHERE archived_at IS NULL;

CREATE OR REPLACE FUNCTION clear_assignments_on_membership_delete() RETURNS trigger AS $$
BEGIN
  UPDATE tasks SET assignee_user_id = NULL, updated_at = now()
  WHERE board_id = OLD.board_id AND assignee_user_id = OLD.user_id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS memberships_clear_task_assignments ON memberships;
CREATE TRIGGER memberships_clear_task_assignments
BEFORE DELETE ON memberships
FOR EACH ROW EXECUTE FUNCTION clear_assignments_on_membership_delete();
