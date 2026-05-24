import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  CLIENT_ORIGIN: z.string().min(1).default('http://localhost:5173'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  BODY_LIMIT: z.string().default('100kb'),
  MONGODB_URI: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),
  JWT_ACCESS_SECRET: z.string().min(1).optional(),
  JWT_REFRESH_SECRET: z.string().min(1).optional(),
  JWT_ISSUER: z.string().min(1).default('messenger-api'),
  JWT_AUDIENCE: z.string().min(1).default('messenger-clients'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL: z.string().default('30d'),
  PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).max(128).default(8),
  PASSWORD_MAX_LENGTH: z.coerce.number().int().min(8).max(256).default(128),
  // Realtime/socket settings.
  SOCKET_PATH: z.string().default('/socket.io'),
  // Per-socket cap for typing.* events. A noisy client (or an attacker on a
  // valid session) cannot meaningfully exceed this without being rate-limited.
  SOCKET_TYPING_MAX_PER_MINUTE: z.coerce
    .number()
    .int()
    .positive()
    .default(60),
  // How long a presence entry survives without a refresh. presence.ping resets
  // the TTL; the cleanup job and disconnect handler also remove stale entries.
  PRESENCE_TTL_SECONDS: z.coerce.number().int().positive().default(90)
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error(
    'Invalid environment variables:',
    parsed.error.flatten().fieldErrors
  );
  throw new Error('Environment validation failed');
}

const data = parsed.data;

if (data.NODE_ENV === 'production') {
  const required = [
    'MONGODB_URI',
    'REDIS_URL',
    'JWT_ACCESS_SECRET',
    'JWT_REFRESH_SECRET'
  ] as const;
  const missing = required.filter((k) => !data[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required production environment variables: ${missing.join(', ')}`
    );
  }
  if (data.CLIENT_ORIGIN.includes('*')) {
    throw new Error('CLIENT_ORIGIN must not use wildcards in production');
  }
  const placeholders = ['replace-me-in-production', 'changeme', 'secret'];
  if (
    placeholders.includes(data.JWT_ACCESS_SECRET ?? '') ||
    placeholders.includes(data.JWT_REFRESH_SECRET ?? '')
  ) {
    throw new Error('JWT secrets must not use placeholder values in production');
  }
}

export const env = {
  ...data,
  isProd: data.NODE_ENV === 'production',
  isTest: data.NODE_ENV === 'test',
  isDev: data.NODE_ENV === 'development',
  corsOrigins: data.CLIENT_ORIGIN.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
};

export type Env = typeof env;
