CREATE TABLE IF NOT EXISTS task_filter_states (
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  filters jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, board_id)
);
