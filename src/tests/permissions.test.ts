import express, {
  type Request,
  type Response,
  type NextFunction
} from 'express';
import request from 'supertest';
import { requireRole } from '../middleware/requireRole';
import { requirePermission } from '../middleware/requirePermission';
import { errorHandler } from '../middleware/errorHandler';
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  hasPermission,
  resolveEffectivePermissions,
  type Permission,
  type Role
} from '../modules/permissions/permissions.constants';

type TestUser = { id: string; role: Role; permissions: Permission[] };

const inject = (user?: TestUser) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (user) req.user = user;
    next();
  };

describe('permission constants', () => {
  it('grants member the basic action permissions', () => {
    expect(hasPermission(ROLES.MEMBER, PERMISSIONS.MESSAGE_CREATE)).toBe(true);
    expect(hasPermission(ROLES.MEMBER, PERMISSIONS.MESSAGE_MODERATE)).toBe(
      false
    );
  });

  it('escalates moderator to include moderation permissions only', () => {
    expect(hasPermission(ROLES.MODERATOR, PERMISSIONS.MESSAGE_MODERATE)).toBe(
      true
    );
    expect(hasPermission(ROLES.MODERATOR, PERMISSIONS.MEDIA_MODERATE)).toBe(
      true
    );
    expect(hasPermission(ROLES.MODERATOR, PERMISSIONS.ADMIN_AUDIT_READ)).toBe(
      false
    );
    expect(hasPermission(ROLES.MODERATOR, PERMISSIONS.ADMIN_USERS_MANAGE)).toBe(
      false
    );
  });

  it('grants admin user-management and audit permissions', () => {
    expect(hasPermission(ROLES.ADMIN, PERMISSIONS.ADMIN_USERS_MANAGE)).toBe(true);
    expect(hasPermission(ROLES.ADMIN, PERMISSIONS.ADMIN_USERS_READ)).toBe(true);
    expect(hasPermission(ROLES.ADMIN, PERMISSIONS.ADMIN_AUDIT_READ)).toBe(true);
    expect(hasPermission(ROLES.ADMIN, PERMISSIONS.ADMIN_SYSTEM_READ)).toBe(true);
  });

  it('grants super-admin every defined permission', () => {
    for (const p of ALL_PERMISSIONS) {
      expect(ROLE_PERMISSIONS[ROLES.SUPER_ADMIN]).toContain(p);
    }
  });

  it('does not declare duplicate permission strings', () => {
    const values = Object.values(PERMISSIONS);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  it('does not duplicate permissions within any role mapping', () => {
    for (const role of Object.values(ROLES)) {
      const perms = ROLE_PERMISSIONS[role];
      expect(new Set(perms).size).toBe(perms.length);
    }
  });
});

describe('resolveEffectivePermissions', () => {
  it('returns role permissions when no custom permissions are supplied', () => {
    const effective = resolveEffectivePermissions(ROLES.MEMBER);
    expect(effective).toEqual(ROLE_PERMISSIONS[ROLES.MEMBER]);
  });

  it('adds custom permissions on top of role permissions without duplicating', () => {
    const effective = resolveEffectivePermissions(ROLES.MEMBER, [
      PERMISSIONS.MESSAGE_MODERATE,
      PERMISSIONS.MESSAGE_CREATE // already in member set
    ]);
    expect(effective).toContain(PERMISSIONS.MESSAGE_MODERATE);
    // No duplicates of the already-granted member permission.
    expect(effective.filter((p) => p === PERMISSIONS.MESSAGE_CREATE)).toHaveLength(
      1
    );
  });
});

describe('requireRole middleware', () => {
  const build = (user?: TestUser) => {
    const app = express();
    app.get(
      '/admin',
      inject(user),
      requireRole(ROLES.ADMIN),
      (_req, res) => {
        res.json({ ok: true });
      }
    );
    app.use(errorHandler);
    return app;
  };

  it('returns 401 when no user is attached', async () => {
    const res = await request(build()).get('/admin');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 403 when role is insufficient', async () => {
    const res = await request(
      build({ id: 'u1', role: ROLES.MEMBER, permissions: [] })
    ).get('/admin');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('allows the request when role matches', async () => {
    const res = await request(
      build({ id: 'u1', role: ROLES.ADMIN, permissions: [] })
    ).get('/admin');
    expect(res.status).toBe(200);
  });
});

describe('requirePermission middleware', () => {
  const build = (user?: TestUser) => {
    const app = express();
    app.get(
      '/mod',
      inject(user),
      requirePermission(PERMISSIONS.MESSAGE_MODERATE),
      (_req, res) => {
        res.json({ ok: true });
      }
    );
    app.use(errorHandler);
    return app;
  };

  it('returns 401 when no user', async () => {
    const res = await request(build()).get('/mod');
    expect(res.status).toBe(401);
  });

  it('returns 403 when role lacks the permission', async () => {
    const res = await request(
      build({ id: 'u1', role: ROLES.MEMBER, permissions: [] })
    ).get('/mod');
    expect(res.status).toBe(403);
  });

  it('allows when the role implicitly grants the permission', async () => {
    const res = await request(
      build({ id: 'u1', role: ROLES.MODERATOR, permissions: [] })
    ).get('/mod');
    expect(res.status).toBe(200);
  });

  it('allows when explicit permission is granted regardless of role grants', async () => {
    const res = await request(
      build({
        id: 'u1',
        role: ROLES.MEMBER,
        permissions: [PERMISSIONS.MESSAGE_MODERATE]
      })
    ).get('/mod');
    expect(res.status).toBe(200);
  });

  it('denies by default — empty permissions deny restricted routes', async () => {
    const res = await request(
      build({ id: 'u1', role: ROLES.MEMBER, permissions: [] })
    ).get('/mod');
    expect(res.status).toBe(403);
  });
});
