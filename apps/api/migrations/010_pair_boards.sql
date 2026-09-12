BEGIN;
ALTER TABLE boards DROP CONSTRAINT IF EXISTS boards_type_check;
ALTER TABLE boards ADD CONSTRAINT boards_type_check CHECK (type IN ('personal', 'chat', 'pair'));
ALTER TABLE boards DROP CONSTRAINT IF EXISTS boards_check;
ALTER TABLE boards ADD CONSTRAINT boards_check CHECK (
  (type IN ('personal', 'pair') AND owner_user_id IS NOT NULL AND telegram_chat_id IS NULL) OR
  (type = 'chat' AND owner_user_id IS NULL AND telegram_chat_id IS NOT NULL)
);
ALTER TABLE boards DROP CONSTRAINT IF EXISTS boards_status_check;
ALTER TABLE boards ADD CONSTRAINT boards_status_check CHECK (status IN ('draft', 'active', 'frozen', 'archived'));
ALTER TABLE boards ADD COLUMN IF NOT EXISTS create_request_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS pair_board_creation_request ON boards(owner_user_id, create_request_id) WHERE type = 'pair';
COMMIT;
