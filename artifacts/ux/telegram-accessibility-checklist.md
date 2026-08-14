# Telegram Mini App accessibility and device checklist

Version: 2026-08-14
Scope: Issue #36

## Automated browser readiness

Checked with a mocked Telegram WebApp contract and representative task data.

- [x] 390 × 844: Tasks, Kanban, Create, Task details, and Settings render without horizontal document overflow.
- [x] 320 × 844: Tasks, Kanban, Create, Task details, and Settings render without horizontal document overflow.
- [x] Telegram light and dark color schemes select the matching application palette.
- [x] System `prefers-color-scheme` is used when Telegram does not provide a color scheme.
- [x] Fallback foreground/background token pairs meet WCAG AA; checked ratios range from 5.52:1 to 15.99:1 for primary and muted text.
- [x] All icon-only buttons on canonical screens have accessible names.
- [x] Task details accessibility tree contains no unnamed buttons, textboxes, comboboxes, checkboxes, or links.
- [x] Keyboard Tab traversal reaches visible controls in task details without a trap.
- [x] Offline status is announced with `role="status"` while loaded data remains visible.
- [x] Loading uses named skeleton status; empty and request error states remain explicit text with retry where applicable.
- [x] Reduced-motion preference disables skeleton and existing interface animation.

Browser screenshot evidence is generated during review and intentionally not committed as product source.

## Physical Telegram device gate

Run before release on current Telegram builds. This remains a device-only release check, not browser evidence.

### iOS Telegram

- [ ] 390 × 844 or nearest available device: top content clears status/header safe area.
- [ ] Bottom navigation, create action, sheets, and comment composer clear home indicator.
- [ ] Light and dark Telegram themes update without reopening Mini App.
- [ ] VoiceOver announces page heading, icon-only controls, task status, fields, errors, and offline status.
- [ ] External keyboard can reach and activate every control; focus remains visible.

### Android Telegram

- [ ] 320 px or nearest narrow device: no clipped controls or horizontal page scroll.
- [ ] Bottom navigation, sheets, and fixed actions clear system gesture/navigation area.
- [ ] Light and dark Telegram themes update without reopening Mini App.
- [ ] TalkBack announces page heading, icon-only controls, task status, fields, errors, and offline status.
- [ ] Hardware keyboard can reach and activate every control; focus remains visible.
