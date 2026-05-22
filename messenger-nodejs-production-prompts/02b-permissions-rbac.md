# Prompt 02b: Permissions And RBAC

You are an expert backend security engineer building a production-grade permission system for a messenger backend.

Inspect the current codebase first. Follow existing auth, middleware, validation, model, and test patterns.

## Goal

Create a permission system that supports system roles, route-level permissions, and resource-level authorization for private messenger data.

## Why This Matters

Messenger apps contain private conversations, messages, attachments, reports, and user data. A user having a valid token is not enough. Every protected action must check both:

- whether the user has the general permission for the action
- whether the user can access the specific resource

## Required Features

- role model or role enum
- permission constants
- role-to-permission mapping
- optional custom user permissions if product requires it
- `requireAuth` middleware
- `requireRole` middleware
- `requirePermission` middleware
- reusable resource authorization helpers
- admin-only permission management placeholder or implementation
- audit log hook for permission/role changes if audit module exists

## Recommended Roles

Use these unless the existing project already has a better model:

```txt
member
moderator
admin
super-admin
```

## Recommended Permissions

Centralize permission names:

```txt
conversation:create
conversation:read
conversation:manage_members
conversation:manage_settings

message:create
message:edit_own
message:delete_own
message:moderate
message:disappearing:manage_own
message:disappearing:manage_group

media:create
media:read
media:delete_own
media:moderate

story:create
story:read
story:delete_own
story:moderate

report:create
report:read_own
report:review
moderation:action

notification:read_own
notification:manage_own

admin:audit:read
admin:users:read
admin:users:manage
admin:system:read
```

## Resource-Level Authorization Helpers

Create helper/service functions for:

- can access conversation
- can manage conversation members
- can update group settings
- can send message to conversation
- can edit message
- can delete message
- can access attachment
- can review report
- can access notification
- can manage user/admin records

Do not scatter these checks randomly across controllers.

## Route-Level Examples

```txt
POST   /api/v1/conversations/direct              requirePermission("conversation:create")
POST   /api/v1/conversations/:id/messages        requirePermission("message:create")
DELETE /api/v1/messages/:id                      requirePermission("message:delete_own") or requirePermission("message:moderate")
GET    /api/v1/reports                           requirePermission("report:review")
GET    /api/v1/admin/audit-logs                  requirePermission("admin:audit:read")
```

Route permission is only the first gate. Always add resource checks inside services.

## Security Rules

- never trust role or permission values from the client
- load roles/permissions from the authenticated server-side user/session
- keep permission names centralized
- avoid broad `admin` checks when a specific permission is better
- `super-admin` should be rare and carefully protected
- permission changes should invalidate or refresh active sessions where needed
- permission and role changes should be audited
- deny by default

## Data Model Guidance

Simple version:

- store `role` on the user with default `member`
- derive permissions from centralized role mapping

Advanced version:

- `roles` collection
- `permissions` collection or constants
- `user_roles`
- optional `user_permission_overrides`

Choose the simple version first unless the product clearly needs dynamic permission management.

## Testing

Add tests for:

- unauthenticated request rejected
- authenticated user without permission rejected
- user with route permission but no resource access rejected
- user can access own allowed resource
- moderator permission works only for moderation actions
- admin-only endpoint rejects normal users
- permission constants are not duplicated if practical

## Done Criteria

- permissions are centralized
- route-level middleware exists
- resource-level authorization helpers exist
- deny-by-default behavior is clear
- sensitive resources require ownership/membership checks
- tests pass
