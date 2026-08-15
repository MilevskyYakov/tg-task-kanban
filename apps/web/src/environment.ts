import { useEffect, useState } from 'react';

type TelegramWebApp = {
  initData: string;
  initDataUnsafe?: { start_param?: string; user?: { first_name: string; last_name?: string; username?: string } };
  colorScheme?: 'light' | 'dark';
  ready(): void;
  expand(): void;
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

export function writeStorage(key: string, value: string): void {
  try { localStorage.setItem(key, value); }
  catch { /* Storage may be unavailable inside a Telegram WebView. */ }
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
