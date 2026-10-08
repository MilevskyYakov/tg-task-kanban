BEGIN;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS chat_root_id uuid REFERENCES boards(id) ON DELETE CASCADE;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS chat_multi_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS chat_members_version bigint NOT NULL DEFAULT 0;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS created_by_user_id bigint REFERENCES users(id);
ALTER TABLE boards ADD COLUMN IF NOT EXISTS chat_create_hash text;
UPDATE boards SET chat_root_id = id WHERE type = 'chat' AND chat_root_id IS NULL;
DROP INDEX IF EXISTS one_board_per_chat;
CREATE UNIQUE INDEX one_board_per_chat ON boards(telegram_chat_id) WHERE type = 'chat' AND chat_root_id = id;
CREATE UNIQUE INDEX IF NOT EXISTS chat_board_creation_request ON boards(chat_root_id, created_by_user_id, create_request_id) WHERE type = 'chat';
CREATE INDEX IF NOT EXISTS boards_chat_root ON boards(chat_root_id);

CREATE OR REPLACE FUNCTION default_chat_root() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.type = 'chat' AND NEW.chat_root_id IS NULL THEN NEW.chat_root_id := NEW.id; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS default_chat_root ON boards;
CREATE TRIGGER default_chat_root BEFORE INSERT ON boards FOR EACH ROW EXECUTE FUNCTION default_chat_root();

CREATE TABLE IF NOT EXISTS chat_aliases (
  telegram_chat_id bigint PRIMARY KEY,
  root_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE
);
INSERT INTO chat_aliases SELECT telegram_chat_id, id FROM boards WHERE type = 'chat' AND chat_root_id = id ON CONFLICT DO NOTHING;

-- Keep the existing membership FK contract (including MCP grant revocation).
-- All application membership writers take the root advisory lock first.
CREATE OR REPLACE FUNCTION sync_chat_memberships() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root uuid; shared boolean; subject bigint;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
  SELECT b.chat_root_id, r.chat_multi_enabled INTO root, shared FROM boards b JOIN boards r ON r.id = b.chat_root_id
    WHERE b.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.board_id ELSE NEW.board_id END;
  IF root IS NULL THEN RETURN NULL; END IF;
  UPDATE boards SET chat_members_version = chat_members_version + 1 WHERE id = root;
  IF NOT shared THEN RETURN NULL; END IF;
  IF TG_OP = 'DELETE' THEN
    DELETE FROM memberships WHERE board_id IN (SELECT id FROM boards WHERE chat_root_id = root) AND user_id = OLD.user_id;
  ELSE
    INSERT INTO memberships (board_id, user_id, role)
      SELECT id, NEW.user_id, NEW.role FROM boards WHERE chat_root_id = root AND id <> NEW.board_id
      ON CONFLICT (board_id, user_id) DO UPDATE SET role = EXCLUDED.role WHERE memberships.role <> EXCLUDED.role;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS sync_chat_memberships ON memberships;
CREATE TRIGGER sync_chat_memberships AFTER INSERT OR UPDATE OR DELETE ON memberships FOR EACH ROW EXECUTE FUNCTION sync_chat_memberships();

ALTER TABLE board_links DROP CONSTRAINT IF EXISTS board_links_kind_check;
ALTER TABLE board_links ADD CONSTRAINT board_links_kind_check CHECK (kind IN ('launch', 'invite', 'publication', 'chat_launch', 'chat_invite'));
ALTER TABLE publication_schedules ADD COLUMN IF NOT EXISTS included_board_ids uuid[];
UPDATE publication_schedules SET included_board_ids = ARRAY[board_id] WHERE included_board_ids IS NULL;
ALTER TABLE publication_runs DROP CONSTRAINT IF EXISTS publication_runs_status_check;
ALTER TABLE publication_runs ADD CONSTRAINT publication_runs_status_check CHECK (status IN ('pending', 'sending', 'sent', 'uncertain', 'cancelled'));
ALTER TABLE publication_runs ADD COLUMN IF NOT EXISTS messages jsonb;
ALTER TABLE publication_runs ADD COLUMN IF NOT EXISTS message_ids bigint[] NOT NULL DEFAULT '{}';
ALTER TABLE publication_runs ADD COLUMN IF NOT EXISTS report_at timestamptz;
ALTER TABLE publication_runs ADD COLUMN IF NOT EXISTS board_ids uuid[];
-- An old process may have delivered a part without committing its receipt.
UPDATE publication_runs SET status = 'uncertain', last_error = 'legacy_delivery_requires_review' WHERE status = 'sending' OR (status = 'pending' AND attempts > 0);
COMMIT;
