ALTER TABLE boards
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('draft', 'active', 'frozen'));
ALTER TABLE boards
  ADD COLUMN IF NOT EXISTS frozen_from_status text
    CHECK (frozen_from_status IN ('draft', 'active'));

CREATE TABLE IF NOT EXISTS board_links (
  token_hash text PRIMARY KEY,
  board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('launch', 'invite')),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS board_links_board_id ON board_links(board_id);
