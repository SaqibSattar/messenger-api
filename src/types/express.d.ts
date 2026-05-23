import type { Role, Permission } from '../modules/permissions/permissions.constants';

declare global {
  namespace Express {
    interface Request {
      id: string;
      user?: {
        id: string;
        role: Role;
        permissions: readonly Permission[];
      };
    }
  }
}

export {};
