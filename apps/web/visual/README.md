# Visual screenshot harness

Run from repository root with `TEST_DATABASE_URL` pointing to an isolated PostgreSQL database. Apply the repository migrations to that test database first:

```sh
DATABASE_URL="$TEST_DATABASE_URL" npm run migrate
npm run test:visual
```

The harness starts Vite with a deterministic mocked Telegram WebApp, captures 390×844 and 320×844 foundation, task-list, board-sheet, filter-sheet, create, details, kanban, and settings screenshots, and checks local font requests, light-only theme, document overflow, approved control anatomy, failed-action input preservation, keyboard-height action reachability, filter-count containment, 200% text sizing, focus trapping, Escape, return focus, and 44×44 px minimum controls. `details.spec.ts` also captures read/edit states and checks complete description rendering, autosizing, clipboard outcomes, explicit save/reopen, and compact GitHub issue editing.

Set `PLAYWRIGHT_PORT` when default port 4173 is occupied, for example `PLAYWRIGHT_PORT=4174 npm run screenshots -w @task/web -- details.spec.ts`.

`PLAYWRIGHT_CHANNEL=chrome` selects an already installed Chrome when the bundled Chromium is unavailable. Playwright still creates a fresh temporary browser profile; it does not use a personal Chrome profile. No browser installation is performed by the harness.

`mcp.spec.ts` covers creation, selected/all editing, access-diff confirmation, preserved drafts on conflict, lost edit/rotation responses, explicit rotation recovery, revocation, keyboard/focus and mobile layouts with real Fastify/DB operations. Evidence is under `artifacts/visual-evidence/issue178/`. Traces/video/automatic failure screenshots are disabled for this suite; explicit screenshots hide `.mcp-key`. Use synthetic sessions only, never a real user's key.

The stale-confirmation regressions remove and restore membership after the confirmation opens, at 320/390 px. Both rename-only and an intentional addition of another board must fail without restoring the lost grant; recovery requires a fresh access snapshot and explicit confirmation naming the restored board.

Generated PNG files are written to `artifacts/visual-evidence/` and intentionally ignored by Git.

`filters.spec.ts` covers the unified #181 panel: native category values, result
counts, assignment exclusivity, independent and full reset, all-board/kanban
restrictions, persisted and stale filters, retry, read-only boards, focus/Back,
long directories, 200% text, simulated keyboard visibility, and context after
creation/details. Its images are in `artifacts/visual-evidence/issue-181/`.
See `docs/issue-181-filters.md` for the contract and remaining device gates.
Use a UTF-8 database with Unicode-aware locale (for example `en_US.UTF-8`);
SQL_ASCII does not implement the application's Cyrillic length/case semantics.

Video tests also require an available FFmpeg executable in Playwright's configured browser cache. Do not install missing runtimes implicitly.

`chat-directions.spec.ts` uses real API handlers and an isolated test DB, with Telegram mocked. It checks single/multiple scoped entry, explicit membership confirmation, stale confirmation, persisted idempotency after a lost response/reload, admin/member views, publication selection, access revocation, 320/390 px layouts, 200% text and the entire name input inside the resized dialog viewport. Run it with `npm run screenshots -w @task/web -- visual/chat-directions.spec.ts`. These checks do not replace physical Telegram keyboard or live Bot API acceptance.

The common chat link is obtained through the UI and real API, not inserted as a `chat_launch` fixture. The check covers link-request failure/retry, selecting the full URL for copying, and keeping old direct links. `settings-autosave.spec.ts --grep 'legacy .* upgrade'` covers older publication drafts, acknowledged lost-response attempts, and concurrent conflicts while preserving the server's current board selection.


Tasca (#134) keeps the light-only contract under dark Telegram/browser settings.
The suite checks local Manrope loading, blocked-font/system fallback, disabled
blur, 200% text, collapsed search and query preservation, grouping in filters,
native horizontal kanban scrolling, touch/keyboard/tab navigation and rollback.
`branding.spec.ts` captures outside, loading, auth failure, empty, offline and
403 states; the actual bot URL remains unchanged. Browser emulation is not
Telegram iOS/Android device acceptance.

`input-perf.spec.ts` samples input-to-next-frame latency and records sparse
Event Timing entries separately; fast input need not emit entries above 16 ms.
Set `PERF_PHASE` and an absolute `PERF_EVIDENCE_DIR` to keep a task's new metrics
separate from historical measurements. For the #134 screenshot/contrast/asset
manifest, run `python3 artifacts/ux/issue-134-layout/collect-evidence.py` after
the checks described in `docs/issue-134-verification.md`.

`backlog.spec.ts` exercises the browser against real Fastify handlers (via `app.inject`) and PostgreSQL using synthetic sessions for an author and another member. Telegram launch/auth remains mocked; no real bot messages are sent. The suite covers partial list creation, lost responses, idempotent replay, competing claims, series context/reset, other unassigned statuses, and loading/error/empty states. Missing `TEST_DATABASE_URL` fails this gate rather than silently skipping it. Test records are deleted in `finally`; never use a production database.

The clipboard cases in `details.spec.ts` dispatch `ClipboardEvent` with binary `File` data, not component callbacks. They cover pending/success/error, timeout without automatic replay, mixed text payloads, read-only cards, listener cleanup and late upload/readback across task/board switches. The API/DB case forwards actual multipart bytes into Fastify, reads them back from PostgreSQL, reopens the card, and checks the ordinary picker, URL attachment and another member's image access. This case requires `TEST_DATABASE_URL` and fails when it is absent. Synthetic events do not perform native text insertion and are not OS-clipboard or Telegram device evidence; see `docs/issue-179-verification.md` for that remaining gate.
