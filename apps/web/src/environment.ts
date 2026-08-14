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

export function resolveThemeScheme(telegramScheme: TelegramWebApp['colorScheme'], prefersDark: boolean): 'light' | 'dark' {
  return telegramScheme ?? (prefersDark ? 'dark' : 'light');
}

export function useTelegramEnvironment(): boolean {
  const [online, setConnection] = useState(() => navigator.onLine);

  useEffect(() => {
    const webApp = window.Telegram?.WebApp;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const syncTheme = () => { document.documentElement.dataset.theme = resolveThemeScheme(webApp?.colorScheme, media.matches); };
    const setOnline = () => setConnection(true);
    const setOffline = () => setConnection(false);

    syncTheme();
    webApp?.onEvent?.('themeChanged', syncTheme);
    media.addEventListener('change', syncTheme);
    window.addEventListener('online', setOnline);
    window.addEventListener('offline', setOffline);
    return () => {
      webApp?.offEvent?.('themeChanged', syncTheme);
      media.removeEventListener('change', syncTheme);
      window.removeEventListener('online', setOnline);
      window.removeEventListener('offline', setOffline);
    };
  }, []);

  return online;
}
