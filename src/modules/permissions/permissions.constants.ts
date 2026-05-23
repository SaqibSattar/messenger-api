export const ROLES = {
  MEMBER: 'member',
  MODERATOR: 'moderator',
  ADMIN: 'admin',
  SUPER_ADMIN: 'super-admin'
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export const PERMISSIONS = {
  CONVERSATION_CREATE: 'conversation:create',
  CONVERSATION_READ: 'conversation:read',
  CONVERSATION_MANAGE_MEMBERS: 'conversation:manage_members',
  CONVERSATION_MANAGE_SETTINGS: 'conversation:manage_settings',

  MESSAGE_CREATE: 'message:create',
  MESSAGE_EDIT_OWN: 'message:edit_own',
  MESSAGE_DELETE_OWN: 'message:delete_own',
  MESSAGE_MODERATE: 'message:moderate',
  MESSAGE_DISAPPEARING_MANAGE_OWN: 'message:disappearing:manage_own',
  MESSAGE_DISAPPEARING_MANAGE_GROUP: 'message:disappearing:manage_group',

  MEDIA_CREATE: 'media:create',
  MEDIA_READ: 'media:read',
  MEDIA_DELETE_OWN: 'media:delete_own',
  MEDIA_MODERATE: 'media:moderate',

  STORY_CREATE: 'story:create',
  STORY_READ: 'story:read',
  STORY_DELETE_OWN: 'story:delete_own',
  STORY_MODERATE: 'story:moderate',

  REPORT_CREATE: 'report:create',
  REPORT_READ_OWN: 'report:read_own',
  REPORT_REVIEW: 'report:review',
  MODERATION_ACTION: 'moderation:action',

  NOTIFICATION_READ_OWN: 'notification:read_own',
  NOTIFICATION_MANAGE_OWN: 'notification:manage_own',

  ADMIN_AUDIT_READ: 'admin:audit:read',
  ADMIN_USERS_READ: 'admin:users:read',
  ADMIN_USERS_MANAGE: 'admin:users:manage',
  ADMIN_SYSTEM_READ: 'admin:system:read'
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(PERMISSIONS);

const memberPermissions: Permission[] = [
  PERMISSIONS.CONVERSATION_CREATE,
  PERMISSIONS.CONVERSATION_READ,
  PERMISSIONS.MESSAGE_CREATE,
  PERMISSIONS.MESSAGE_EDIT_OWN,
  PERMISSIONS.MESSAGE_DELETE_OWN,
  PERMISSIONS.MESSAGE_DISAPPEARING_MANAGE_OWN,
  PERMISSIONS.MEDIA_CREATE,
  PERMISSIONS.MEDIA_READ,
  PERMISSIONS.MEDIA_DELETE_OWN,
  PERMISSIONS.STORY_CREATE,
  PERMISSIONS.STORY_READ,
  PERMISSIONS.STORY_DELETE_OWN,
  PERMISSIONS.REPORT_CREATE,
  PERMISSIONS.REPORT_READ_OWN,
  PERMISSIONS.NOTIFICATION_READ_OWN,
  PERMISSIONS.NOTIFICATION_MANAGE_OWN
];

const moderatorPermissions: Permission[] = [
  ...memberPermissions,
  PERMISSIONS.MESSAGE_MODERATE,
  PERMISSIONS.MEDIA_MODERATE,
  PERMISSIONS.STORY_MODERATE,
  PERMISSIONS.REPORT_REVIEW,
  PERMISSIONS.MODERATION_ACTION
];

const adminPermissions: Permission[] = [
  ...moderatorPermissions,
  PERMISSIONS.CONVERSATION_MANAGE_MEMBERS,
  PERMISSIONS.CONVERSATION_MANAGE_SETTINGS,
  PERMISSIONS.MESSAGE_DISAPPEARING_MANAGE_GROUP,
  PERMISSIONS.ADMIN_AUDIT_READ,
  PERMISSIONS.ADMIN_USERS_READ,
  PERMISSIONS.ADMIN_USERS_MANAGE,
  PERMISSIONS.ADMIN_SYSTEM_READ
];

const superAdminPermissions: Permission[] = [...ALL_PERMISSIONS];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  [ROLES.MEMBER]: memberPermissions,
  [ROLES.MODERATOR]: moderatorPermissions,
  [ROLES.ADMIN]: adminPermissions,
  [ROLES.SUPER_ADMIN]: superAdminPermissions
};

export const hasPermission = (role: Role, permission: Permission): boolean =>
  ROLE_PERMISSIONS[role]?.includes(permission) ?? false;

// Single source of truth for "what permissions does this user effectively have".
// Callers must pass both the role-derived set and any per-user overrides so a
// stale role on the request object cannot widen access.
export const resolveEffectivePermissions = (
  role: Role,
  customPermissions: readonly Permission[] = []
): readonly Permission[] => {
  const fromRole = ROLE_PERMISSIONS[role] ?? [];
  if (customPermissions.length === 0) return fromRole;
  const set = new Set<Permission>(fromRole);
  for (const p of customPermissions) set.add(p);
  return Array.from(set);
};
