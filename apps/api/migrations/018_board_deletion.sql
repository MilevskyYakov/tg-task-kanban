BEGIN;
-- A chat root remains the stable identity for membership, links and schedules.
-- Deletion hides only its task board; it never deletes the chat container.
ALTER TABLE boards ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS lifecycle_version bigint NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS board_lifecycle_events (
  board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  actor_user_id bigint NOT NULL REFERENCES users(id),
  action text NOT NULL CHECK (action IN ('delete', 'restore')),
  confirmation text NOT NULL,
  version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, request_id)
);
-- Use the same read boundary in HTTP, shared mutations and MCP. Management of
-- the chat container deliberately retains the underlying memberships table.
CREATE OR REPLACE VIEW available_memberships AS
  SELECT m.* FROM memberships m JOIN boards b ON b.id = m.board_id WHERE b.deleted_at IS NULL;
COMMIT;
