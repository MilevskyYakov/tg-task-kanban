BEGIN;

WITH ranked AS (
  SELECT id,
    first_value(id) OVER (PARTITION BY board_id, lower(btrim(name)) ORDER BY created_at, id) AS canonical_id,
    row_number() OVER (PARTITION BY board_id, lower(btrim(name)) ORDER BY created_at, id) AS position
  FROM projects
  WHERE archived_at IS NULL
)
UPDATE tasks t SET project_id = ranked.canonical_id
FROM ranked
WHERE ranked.position > 1 AND t.project_id = ranked.id;

WITH ranked AS (
  SELECT id,
    first_value(id) OVER (PARTITION BY board_id, lower(btrim(name)) ORDER BY created_at, id) AS canonical_id,
    row_number() OVER (PARTITION BY board_id, lower(btrim(name)) ORDER BY created_at, id) AS position
  FROM projects
  WHERE archived_at IS NULL
)
UPDATE recurrence_templates r SET project_id = ranked.canonical_id
FROM ranked
WHERE ranked.position > 1 AND r.project_id = ranked.id;

WITH ranked AS (
  SELECT id,
    row_number() OVER (PARTITION BY board_id, lower(btrim(name)) ORDER BY created_at, id) AS position
  FROM projects
  WHERE archived_at IS NULL
)
UPDATE projects p SET archived_at = now()
FROM ranked
WHERE ranked.position > 1 AND p.id = ranked.id;

CREATE UNIQUE INDEX IF NOT EXISTS projects_board_active_name_unique
  ON projects(board_id, lower(btrim(name)))
  WHERE archived_at IS NULL;

COMMIT;
