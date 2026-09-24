import { useEffect, useState } from 'react';

type TelegramWebApp = {
  initData: string;
  initDataUnsafe?: { start_param?: string; user?: { first_name: string; last_name?: string; username?: string } };
  colorScheme?: 'light' | 'dark';
  ready(): void;
  expand(): void;
  close?(): void;
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
