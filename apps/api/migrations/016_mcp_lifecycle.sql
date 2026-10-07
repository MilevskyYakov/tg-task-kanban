BEGIN;
ALTER TABLE mcp_connections ADD COLUMN IF NOT EXISTS board_selection text NOT NULL DEFAULT 'selected' CHECK (board_selection IN ('selected', 'all'));
ALTER TABLE mcp_connections ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0);
ALTER TABLE mcp_connections DROP CONSTRAINT IF EXISTS mcp_connections_board_count_check;
ALTER TABLE mcp_connections ADD CONSTRAINT mcp_connections_board_count_check CHECK (board_count >= 0);

-- A deletion is remembered even when no MCP request occurs before rejoining.
-- Do not lock connections here: board/member operations must never invert the MCP lock order.
CREATE TABLE IF NOT EXISTS mcp_membership_losses (
  board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (board_id, user_id)
);
CREATE OR REPLACE FUNCTION remember_mcp_membership_loss() RETURNS trigger AS $$
BEGIN
  INSERT INTO mcp_membership_losses (board_id, user_id)
    SELECT OLD.board_id, OLD.user_id
    WHERE EXISTS (SELECT 1 FROM boards WHERE id=OLD.board_id)
      AND EXISTS (SELECT 1 FROM users WHERE id=OLD.user_id)
    ON CONFLICT DO NOTHING;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS memberships_mcp_loss ON memberships;
CREATE TRIGGER memberships_mcp_loss AFTER DELETE ON memberships
FOR EACH ROW EXECUTE FUNCTION remember_mcp_membership_loss();

-- Receipts also form a secret-free lifecycle audit. No names, task data or key hashes.
CREATE TABLE IF NOT EXISTS mcp_connection_events (
  connection_id uuid NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  action text NOT NULL CHECK (action IN ('created', 'edited', 'rotated', 'revoked')),
  revision bigint NOT NULL,
  mode text NOT NULL CHECK (mode IN ('read', 'write')),
  board_selection text NOT NULL CHECK (board_selection IN ('selected', 'all')),
  board_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, request_id)
);
COMMIT;
