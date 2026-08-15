# Visual screenshot harness

Run from repository root:

```sh
npm run test:visual
```

The harness starts Vite with a deterministic mocked Telegram WebApp, captures 390×844 and 320×844 foundation, task-list, board-sheet, and filter-sheet screenshots, and checks local font requests, light-only theme, document overflow, task-row anatomy, filter-count containment, 200% text sizing, focus trapping, Escape, return focus, and 44×44 px minimum controls.

Generated PNG files are written to `artifacts/visual-evidence/` and intentionally ignored by Git.
