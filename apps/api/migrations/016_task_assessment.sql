BEGIN;
-- This repository replays migrations. Column creation and backfill share one transaction;
-- a later explicit reset must never be reinterpreted as a legacy value.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='tasks' AND column_name='importance') THEN
    ALTER TABLE tasks ADD COLUMN importance boolean, ADD COLUMN urgency boolean;
    UPDATE tasks SET urgency=CASE WHEN priority='urgent' THEN true ELSE NULL END;
    ALTER TABLE recurrence_templates ADD COLUMN importance boolean, ADD COLUMN urgency boolean, ADD COLUMN revision bigint NOT NULL DEFAULT 1;
    UPDATE recurrence_templates SET urgency=CASE WHEN priority='urgent' THEN true ELSE NULL END;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION recurrence_revision_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF (to_jsonb(NEW)-'next_occurrence_at'-'updated_at'-'revision') IS DISTINCT FROM
     (to_jsonb(OLD)-'next_occurrence_at'-'updated_at'-'revision') THEN
    NEW.revision=OLD.revision+1;
  ELSE NEW.revision=OLD.revision;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS recurrence_revision ON recurrence_templates;
CREATE TRIGGER recurrence_revision BEFORE UPDATE ON recurrence_templates FOR EACH ROW EXECUTE FUNCTION recurrence_revision_update();

-- Text keys preserve PostgreSQL microseconds and the date-only exclusive day end.
-- Consumers compare these keys bytewise; no client-side timezone approximation.
CREATE OR REPLACE FUNCTION task_priority_key(boolean, boolean, timestamptz, date, text, timestamptz, uuid)
RETURNS text[] LANGUAGE sql STABLE AS $$
 SELECT ARRAY[
   CASE WHEN $1 IS NULL OR $2 IS NULL THEN '0' WHEN $2 THEN CASE WHEN $1 THEN '1' ELSE '2' END ELSE CASE WHEN $1 THEN '3' ELSE '4' END END,
   CASE WHEN $3 IS NULL AND $4 IS NULL THEN '1' ELSE '0' END,
   COALESCE(to_char(COALESCE($3, ($4+1)::timestamp AT TIME ZONE $5) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), ''),
   to_char($6 AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), $7::text]
$$;
COMMIT;
