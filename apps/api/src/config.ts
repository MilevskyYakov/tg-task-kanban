export type Config = {
  botToken: string;
  databaseUrl: string;
  sessionSecret: string;
  initDataMaxAgeSeconds: number;
  sessionMaxAgeSeconds: number;
  host: string;
  port: number;
  production: boolean;
};

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function loadConfig(): Config {
  const botToken = process.env.BOT_TOKEN ?? '';
  const databaseUrl = process.env.DATABASE_URL ?? '';
  const sessionSecret = process.env.SESSION_SECRET ?? '';
  if (!botToken) throw new Error('BOT_TOKEN is required');
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (sessionSecret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters');
  return {
    botToken,
    databaseUrl,
    sessionSecret,
    initDataMaxAgeSeconds: positiveInteger('INIT_DATA_MAX_AGE_SECONDS', 86400),
    sessionMaxAgeSeconds: positiveInteger('SESSION_MAX_AGE_SECONDS', 604800),
    host: process.env.HOST ?? '127.0.0.1',
    port: positiveInteger('PORT', 2240),
    production: process.env.NODE_ENV === 'production'
  };
}
