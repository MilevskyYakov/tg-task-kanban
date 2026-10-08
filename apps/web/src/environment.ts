import { useEffect, useState } from 'react';

type TelegramWebApp = {
  initData: string;
  initDataUnsafe?: { start_param?: string; user?: { first_name: string; last_name?: string; username?: string } };
  colorScheme?: 'light' | 'dark';
  ready(): void;
  expand(): void;
  close?(): void;
  isVersionAtLeast?(version: string): boolean;
  HapticFeedback?: { impactOccurred(style: 'soft'): unknown };
  BackButton?: { isVisible: boolean; show(): void; hide(): void; onClick(listener: () => void): void; offClick(listener: () => void): void };
  openTelegramLink?(url: string): void;
  onEvent?(event: 'themeChanged', listener: () => void): void;
  offEvent?(event: 'themeChanged', listener: () => void): void;
};

declare global {
  interface Window { Telegram?: { WebApp?: TelegramWebApp } }
}

export function resolveThemeScheme(): 'light' {
  return 'light';
}

export function readStorage(key: string): string | null {
  try { return localStorage.getItem(key); }
  catch { return null; }
}

// Returns false when the value could not be persisted (quota/full/WebView storage
// unavailable) so callers can warn instead of promising a saved draft (issue #129).
export function writeStorage(key: string, value: string): boolean {
  try { localStorage.setItem(key, value); return true; }
  catch { return false; }
}

export function removeStorage(key: string): void {
  try { localStorage.removeItem(key); }
  catch { /* Storage may be unavailable inside a Telegram WebView. */ }
}

// Telegram 6.1+: optional, device-dependent feedback, never part of saving.
export function creationHaptic(enabled: boolean): void {
  if (!enabled || document.visibilityState !== 'visible') return;
  try {
    const app = window.Telegram?.WebApp;
    if (app?.isVersionAtLeast?.('6.1')) app.HapticFeedback?.impactOccurred('soft');
  } catch { /* Unsupported device feedback must not affect creation. */ }
}

// Keyboard-aware layout is shared by creation, details and filters. Focus alone
// is not a keyboard signal (desktop, hardware keyboards, and pinch zoom).
export function useTaskKeyboardViewport(): void {
  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    let fullHeight = window.innerHeight;
    let width = window.innerWidth;
    let keyboardOpen = false;
    let frame = 0;
    const update = () => {
      if (viewport && Math.abs(viewport.scale - 1) > 0.05) return;
      const active = document.activeElement;
      const editable = (active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && /^(text|search|email|url|tel|number|password)$/.test(active.type)))
        && !active.readOnly && !active.disabled && active.closest('.create-screen, .task-details, .unified-filter-sheet');
      const height = Math.min(window.innerHeight, viewport?.height ?? window.innerHeight);
      const top = viewport?.offsetTop ?? 0;
      if (width !== window.innerWidth) { width = window.innerWidth; fullHeight = window.innerHeight; }
      if (!editable && !keyboardOpen) fullHeight = window.innerHeight;
      fullHeight = Math.max(fullHeight, window.innerHeight);
      // Ignore browser chrome changes; retain layout through submit/blur until
      // the keyboard actually closes, so the tapped button cannot jump away.
      keyboardOpen = fullHeight - height > 120 && Boolean(editable || keyboardOpen);
      root.toggleAttribute('data-task-keyboard', keyboardOpen);
      if (!keyboardOpen) {
        root.style.removeProperty('--task-input-height');
        root.style.removeProperty('--task-keyboard-inset');
        return;
      }
      root.style.setProperty('--task-input-height', `${Math.max(44, height - 48)}px`);
      root.style.setProperty('--task-keyboard-inset', `${Math.max(0, window.innerHeight - height - top)}px`);
      const filterBody = editable ? active.closest<HTMLElement>('.filter-body') : null;
      if (filterBody && active) {
        const field = active.getBoundingClientRect(), container = filterBody.getBoundingClientRect();
        filterBody.scrollTop += field.top < container.top + 12 ? field.top - container.top - 12
          : field.bottom > container.bottom - 12 ? field.bottom - container.bottom + 12 : 0;
        return;
      }
      if (!editable || active.closest('[role="dialog"]')) return;
      // WebKit may leave an autosized textarea scrolled to its beginning after
      // it is capped. Reveal an end-caret without changing selection or drafts.
      if (active instanceof HTMLTextAreaElement && active.selectionStart === active.selectionEnd && active.selectionEnd === active.value.length) {
        active.scrollTop = active.scrollHeight;
      }
      // Keep the bounded editor visible. Do not fight intentional page scrolling.
      const rect = active.getBoundingClientRect();
      const delta = rect.top < top + 12 ? rect.top - top - 12
        : rect.bottom > top + height - 12 ? rect.bottom - top - height + 12 : 0;
      if (Math.abs(delta) > 1) window.scrollBy({ top: delta, behavior: 'instant' });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        update();
        // The first scroll can be clamped to the old document height until the
        // keyboard padding is committed. Recheck once, not on manual scrolling.
        if (keyboardOpen) frame = requestAnimationFrame(update);
      });
    };
    document.addEventListener('focusin', schedule);
    document.addEventListener('focusout', schedule);
    document.addEventListener('input', schedule);
    window.addEventListener('resize', schedule);
    viewport?.addEventListener('resize', schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('focusin', schedule);
      document.removeEventListener('focusout', schedule);
      document.removeEventListener('input', schedule);
      window.removeEventListener('resize', schedule);
      viewport?.removeEventListener('resize', schedule);
      root.removeAttribute('data-task-keyboard');
      root.style.removeProperty('--task-input-height');
      root.style.removeProperty('--task-keyboard-inset');
    };
  }, []);
}

export function useTelegramEnvironment(): boolean {
  const [online, setConnection] = useState(() => navigator.onLine);

  useEffect(() => {
    const setOnline = () => setConnection(true);
    const setOffline = () => setConnection(false);

    document.documentElement.dataset.theme = resolveThemeScheme();
    window.addEventListener('online', setOnline);
    window.addEventListener('offline', setOffline);
    return () => {
      window.removeEventListener('online', setOnline);
      window.removeEventListener('offline', setOffline);
    };
  }, []);

  return online;
}
