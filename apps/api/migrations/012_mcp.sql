CREATE TABLE IF NOT EXISTS mcp_connections (
  id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  mode text NOT NULL CHECK (mode IN ('read', 'write')),
  key_hash text NOT NULL UNIQUE,
  create_request_id uuid NOT NULL,
  request_hash text NOT NULL,
  board_count integer NOT NULL CHECK (board_count > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (user_id, create_request_id),
  UNIQUE (id, user_id)
);
CREATE TABLE IF NOT EXISTS mcp_board_grants (
  connection_id uuid NOT NULL,
  user_id bigint NOT NULL,
  board_id uuid NOT NULL,
  PRIMARY KEY (connection_id, board_id),
  FOREIGN KEY (connection_id, user_id) REFERENCES mcp_connections(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (board_id, user_id) REFERENCES memberships(board_id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS mcp_grants_membership ON mcp_board_grants(board_id, user_id);
CREATE TABLE IF NOT EXISTS mcp_write_receipts (
  connection_id uuid NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  version bigint NOT NULL,
  warning text,
  PRIMARY KEY (connection_id, request_id)
);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1;
CREATE OR REPLACE FUNCTION increment_task_revision() RETURNS trigger AS $$
BEGIN
  NEW.revision := OLD.revision + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS tasks_increment_revision ON tasks;
CREATE TRIGGER tasks_increment_revision BEFORE UPDATE ON tasks
FOR EACH ROW EXECUTE FUNCTION increment_task_revision();
ALTER TABLE task_audit_events ADD COLUMN IF NOT EXISTS mcp_connection_id uuid REFERENCES mcp_connections(id) ON DELETE SET NULL;
ALTER TABLE task_audit_events ADD COLUMN IF NOT EXISTS mcp_request_id uuid;
CREATE OR REPLACE FUNCTION annotate_mcp_audit() RETURNS trigger AS $$
BEGIN
  NEW.mcp_connection_id := NULLIF(current_setting('task.mcp_connection_id', true), '')::uuid;
  NEW.mcp_request_id := NULLIF(current_setting('task.mcp_request_id', true), '')::uuid;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS task_audit_mcp_context ON task_audit_events;
CREATE TRIGGER task_audit_mcp_context BEFORE INSERT ON task_audit_events
FOR EACH ROW EXECUTE FUNCTION annotate_mcp_audit();
