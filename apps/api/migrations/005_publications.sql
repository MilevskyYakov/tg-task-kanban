ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_at timestamptz;
UPDATE tasks SET completed_at = updated_at WHERE status = 'done' AND completed_at IS NULL;

CREATE TABLE IF NOT EXISTS publication_schedules (
  board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('daily', 'weekly')),
  enabled boolean NOT NULL DEFAULT false,
  weekdays smallint[] NOT NULL,
  local_time time NOT NULL,
  timezone text NOT NULL DEFAULT 'Europe/Moscow',
  included_statuses text[] NOT NULL DEFAULT ARRAY['todo', 'in_progress', 'waiting'],
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, kind),
  CHECK (weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[]),
  CHECK (included_statuses <@ ARRAY['todo', 'in_progress', 'waiting', 'done']::text[])
);

INSERT INTO publication_schedules (board_id, kind, weekdays, local_time)
SELECT id, 'daily', ARRAY[1,2,3,4,5]::smallint[], '11:00' FROM boards WHERE type = 'chat'
ON CONFLICT DO NOTHING;
INSERT INTO publication_schedules (board_id, kind, weekdays, local_time)
SELECT id, 'weekly', ARRAY[1]::smallint[], '10:30' FROM boards WHERE type = 'chat'
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS publication_runs (
  id uuid PRIMARY KEY,
  board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('daily', 'weekly')),
  local_date date NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent')),
  attempts smallint NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  last_error text,
  UNIQUE (board_id, kind, local_date)
);
CREATE INDEX IF NOT EXISTS publication_runs_pending ON publication_runs(next_attempt_at) WHERE status = 'pending';

ALTER TABLE board_links DROP CONSTRAINT IF EXISTS board_links_kind_check;
ALTER TABLE board_links ADD CONSTRAINT board_links_kind_check CHECK (kind IN ('launch', 'invite', 'publication'));
