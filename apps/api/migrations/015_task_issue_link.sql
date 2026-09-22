ALTER TABLE tasks ADD COLUMN IF NOT EXISTS issue_url text;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_issue_url_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_issue_url_check CHECK (
  issue_url IS NULL OR issue_url ~* '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/issues/[1-9][0-9]*$'
    AND char_length(issue_url) <= 500);
