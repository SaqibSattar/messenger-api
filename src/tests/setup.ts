process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT ?? '3001';
process.env.CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? 'test-access-secret-not-for-production';
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET ?? 'test-refresh-secret-not-for-production';
process.env.ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL ?? '15m';
process.env.REFRESH_TOKEN_TTL = process.env.REFRESH_TOKEN_TTL ?? '30d';
