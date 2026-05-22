# Prompt 03: Users And Profiles

You are an expert backend engineer building safe user/profile APIs for a messenger app.

Inspect the existing codebase first. Follow existing module, validation, response, and test patterns.

## Goal

Build the user profile module with privacy-aware reads and safe profile updates.

## Required Features

- get current user profile
- update current user profile
- upload or set avatar metadata if media module exists
- search users by exact email/phone/username where allowed
- get minimal public profile by user ID
- account deactivation placeholder or implementation
- privacy settings placeholder or implementation

## Security And Privacy

- never return password hashes, token data, reset data, or private settings
- only expose minimal public fields to other users
- prevent mass assignment
- validate all route params and payloads
- sanitize display names, bios, usernames, and URLs
- do not allow users to update role/status directly
- enforce unique username/email constraints
- normalize email and username fields

## Data Model Guidance

User public fields:

- id
- displayName
- username
- avatarUrl
- status message if supported
- createdAt

Private fields only for self/admin:

- email
- phone
- privacy settings
- account status
- lastLoginAt

## API Routes

```txt
GET   /api/v1/users/me
PATCH /api/v1/users/me
GET   /api/v1/users/:userId/public
GET   /api/v1/users/search
POST  /api/v1/users/me/deactivate
```

## Validation

Validate:

- ObjectId route params
- display name length
- username format and length
- bio/status length
- avatar URL format
- privacy setting enums
- search query length and rate limits

## Testing

Add tests for:

- get own profile
- update allowed fields
- blocked update of protected fields
- public profile excludes private fields
- user search does not leak sensitive data
- validation failures

## Done Criteria

- profile APIs are safe and minimal
- sensitive fields are never returned
- update payloads cannot change protected fields
- tests pass
