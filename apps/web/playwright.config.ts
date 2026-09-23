import { defineConfig } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_PORT ?? '4173');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PLAYWRIGHT_PORT must be an integer from 1024 to 65535');
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './visual',
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL,
    browserName: 'chromium',
    colorScheme: 'dark',
    locale: 'ru-RU',
    reducedMotion: 'reduce'
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false
  }
});
