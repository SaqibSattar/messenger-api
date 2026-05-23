process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT ?? '3001';
process.env.CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';
