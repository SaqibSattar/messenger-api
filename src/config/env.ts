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
  // Hard cap on per-request lifetime (ms). 0 disables. Set generously above
  // the slowest realistic route; long-running work belongs in a job, not on
  // the request path.
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(0).default(15_000),
  // Trust proxy hop count when deployed behind a load balancer (e.g. ALB,
  // nginx, Cloudflare). Without this, rate-limit and audit IPs reflect the
  // proxy, not the real client. Leave at 0 in single-host development.
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
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
  PRESENCE_TTL_SECONDS: z.coerce.number().int().positive().default(90),
  // Media / attachment settings. The defaults are conservative — a 25 MB cap
  // covers normal photos, short videos, and PDFs without letting clients push
  // a request that would dominate the API egress budget.
  STORAGE_PROVIDER: z.enum(['memory', 's3']).default('memory'),
  STORAGE_BUCKET: z.string().min(1).optional(),
  STORAGE_REGION: z.string().min(1).optional(),
  STORAGE_ACCESS_KEY_ID: z.string().min(1).optional(),
  STORAGE_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  // Public base URL prefix used by the memory provider for synthetic signed
  // URLs. A real S3 provider derives its host from bucket/region instead.
  STORAGE_PUBLIC_BASE_URL: z.string().min(1).default('https://storage.example.local'),
  // Secret used by the memory provider to sign URLs. Required-in-production
  // checks (see below) reject the placeholder.
  STORAGE_SIGNING_SECRET: z
    .string()
    .min(1)
    .default('replace-me-storage-signing-secret'),
  MEDIA_MAX_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  MEDIA_UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  MEDIA_DOWNLOAD_URL_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(300),
  // Pending attachments older than this with no `complete` call are reaped by
  // the orphan cleanup job.
  MEDIA_PENDING_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  MEDIA_MAX_ATTACHMENTS_PER_MESSAGE: z.coerce
    .number()
    .int()
    .positive()
    .max(20)
    .default(10)
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
  if (data.STORAGE_PROVIDER === 's3') {
    const requiredForS3 = [
      'STORAGE_BUCKET',
      'STORAGE_REGION',
      'STORAGE_ACCESS_KEY_ID',
      'STORAGE_SECRET_ACCESS_KEY'
    ] as const;
    const missingS3 = requiredForS3.filter((k) => !data[k]);
    if (missingS3.length > 0) {
      throw new Error(
        `STORAGE_PROVIDER=s3 requires ${missingS3.join(', ')} to be set`
      );
    }
  }
  if (
    data.STORAGE_SIGNING_SECRET === 'replace-me-storage-signing-secret' ||
    placeholders.includes(data.STORAGE_SIGNING_SECRET)
  ) {
    throw new Error(
      'STORAGE_SIGNING_SECRET must not use placeholder values in production'
    );
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
