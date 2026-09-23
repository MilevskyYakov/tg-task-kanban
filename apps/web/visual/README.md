# Visual screenshot harness

Run from repository root with `TEST_DATABASE_URL` pointing to an isolated PostgreSQL database. Apply the repository migrations to that test database first:

```sh
DATABASE_URL="$TEST_DATABASE_URL" npm run migrate
npm run test:visual
```

The harness starts Vite with a deterministic mocked Telegram WebApp, captures 390×844 and 320×844 foundation, task-list, board-sheet, filter-sheet, create, details, kanban, and settings screenshots, and checks local font requests, light-only theme, document overflow, approved control anatomy, failed-action input preservation, keyboard-height action reachability, filter-count containment, 200% text sizing, focus trapping, Escape, return focus, and 44×44 px minimum controls. `details.spec.ts` also captures read/edit states and checks complete description rendering, autosizing, clipboard outcomes, explicit save/reopen, and compact GitHub issue editing.

Set `PLAYWRIGHT_PORT` when default port 4173 is occupied, for example `PLAYWRIGHT_PORT=4174 npm run screenshots -w @task/web -- details.spec.ts`.

Generated PNG files are written to `artifacts/visual-evidence/` and intentionally ignored by Git.

`backlog.spec.ts` exercises the browser against real Fastify handlers (via `app.inject`) and PostgreSQL using synthetic sessions for an author and another member. Telegram launch/auth remains mocked; no real bot messages are sent. The suite covers partial list creation, lost responses, idempotent replay, competing claims, series context/reset, other unassigned statuses, and loading/error/empty states. Missing `TEST_DATABASE_URL` fails this gate rather than silently skipping it. Test records are deleted in `finally`; never use a production database.
