import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

import { env } from './config/env';
import { requestId, REQUEST_ID_HEADER } from './middleware/requestId';
import { httpLogger } from './middleware/httpLogger';
import { notFound } from './middleware/notFound';
import { errorHandler } from './middleware/errorHandler';
import { asyncHandler } from './middleware/asyncHandler';
import { requireAuth } from './middleware/auth';
import { requirePermission } from './middleware/requirePermission';
import { ok } from './utils/apiResponse';
import { isMongoReady } from './db/mongo';
import { isRedisReady } from './db/redis';
import { PERMISSIONS } from './modules/permissions/permissions.constants';
import { getProcessMetrics } from './utils/metrics';
import { authRouter } from './modules/auth/auth.routes';
import { adminRouter } from './modules/admin/admin.routes';
import { userRouter } from './modules/users/user.routes';
import { conversationRouter } from './modules/conversations/conversation.routes';
import {
  conversationMessagesRouter,
  messageRouter
} from './modules/messages/message.routes';
import { mediaRouter } from './modules/media/media.routes';
import { storyRouter } from './modules/stories/story.routes';
import {
  blockRouter,
  moderationRouter,
  reportRouter
} from './modules/moderation/moderation.routes';
import {
  notificationPreferencesRouter,
  notificationRouter
} from './modules/notifications/notification.routes';
import { searchRouter } from './modules/search/search.routes';

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

  // Operational metrics. Behind admin auth so a public scrape cannot harvest
  // dependency/process information. Returns only privacy-safe counters —
  // process stats and collection sizes, never user-identifying data.
  app.get(
    '/metrics',
    requireAuth,
    requirePermission(PERMISSIONS.ADMIN_SYSTEM_READ),
    asyncHandler(async (_req, res) => {
      const metrics = await getProcessMetrics();
      ok(res, metrics);
      return undefined;
    })
  );

  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/users', userRouter);
  app.use(
    '/api/v1/conversations/:conversationId/messages',
    conversationMessagesRouter
  );
  app.use('/api/v1/conversations', conversationRouter);
  app.use('/api/v1/messages', messageRouter);
  app.use('/api/v1/media', mediaRouter);
  app.use('/api/v1/stories', storyRouter);
  app.use('/api/v1/blocks', blockRouter);
  app.use('/api/v1/reports', reportRouter);
  app.use('/api/v1/moderation', moderationRouter);
  app.use('/api/v1/search', searchRouter);
  app.use('/api/v1/notifications', notificationRouter);
  app.use('/api/v1/notification-preferences', notificationPreferencesRouter);
  app.use('/api/v1/admin', adminRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
};
