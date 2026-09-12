ALTER TABLE boards ADD COLUMN IF NOT EXISTS telegram_member_update_id bigint;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS telegram_member_date bigint;

-- Existing boards deliberately have no delivery record: no migration of old pins.
CREATE TABLE IF NOT EXISTS telegram_entry_deliveries (
  key text PRIMARY KEY,
  board_id uuid REFERENCES boards(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'uncertain')),
  message_id bigint,
  error_code text,
  attempts integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
