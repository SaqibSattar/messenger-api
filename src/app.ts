import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

import { env } from './config/env';
import { requestId, REQUEST_ID_HEADER } from './middleware/requestId';
import { httpLogger } from './middleware/httpLogger';
import { notFound } from './middleware/notFound';
import { errorHandler } from './middleware/errorHandler';
import { ok } from './utils/apiResponse';
import { isMongoReady } from './db/mongo';
import { isRedisReady } from './db/redis';
import { authRouter } from './modules/auth/auth.routes';
import { adminRouter } from './modules/admin/admin.routes';
import { userRouter } from './modules/users/user.routes';

export const buildApp = (): Express => {
  const app = express();

  app.disable('x-powered-by');

  app.use(requestId);
  app.use(httpLogger);
  app.use(helmet());

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (env.corsOrigins.includes(origin)) return callback(null, true);
        return callback(new Error('Not allowed by CORS'));
      },
      credentials: true,
      exposedHeaders: [REQUEST_ID_HEADER]
    })
  );

  app.use(express.json({ limit: env.BODY_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: env.BODY_LIMIT }));

  // Conservative global limiter; per-route limiters live in feature modules.
  if (!env.isTest) {
    app.use(
      rateLimit({
        windowMs: 60_000,
        limit: 300,
        standardHeaders: 'draft-7',
        legacyHeaders: false
      })
    );
  }

  app.get('/health', (_req, res) => {
    ok(res, { status: 'up', uptime: process.uptime() });
  });

  app.get('/ready', (_req, res) => {
    const checks = { mongo: isMongoReady(), redis: isRedisReady() };
    const ready = Object.values(checks).every(Boolean);
    res.status(ready ? 200 : 503).json({
      success: ready,
      data: { checks }
    });
  });

  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/users', userRouter);
  app.use('/api/v1/admin', adminRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
};
