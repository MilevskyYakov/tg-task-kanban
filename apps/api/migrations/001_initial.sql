CREATE TABLE IF NOT EXISTS users (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  telegram_id bigint NOT NULL UNIQUE,
  first_name text NOT NULL,
  username text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS boards (
  id uuid PRIMARY KEY,
  type text NOT NULL CHECK (type IN ('chat', 'personal')),
  name text NOT NULL,
  owner_user_id bigint REFERENCES users(id),
  telegram_chat_id bigint,
  CHECK (
    (type = 'personal' AND owner_user_id IS NOT NULL AND telegram_chat_id IS NULL) OR
    (type = 'chat' AND owner_user_id IS NULL AND telegram_chat_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS one_personal_board_per_owner
  ON boards(owner_user_id) WHERE type = 'personal';
CREATE UNIQUE INDEX IF NOT EXISTS one_board_per_chat
  ON boards(telegram_chat_id) WHERE type = 'chat';

CREATE TABLE IF NOT EXISTS memberships (
  board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'member', 'admin')),
  PRIMARY KEY (board_id, user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);
