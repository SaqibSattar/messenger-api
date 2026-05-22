# Prompt 07b: Stories And Status

You are an expert backend engineer building stories/status features for a production messenger app.

Inspect existing user, media, privacy, contacts, blocking, notification, and cleanup job code first. Follow established patterns.

## Goal

Add stories/status posts with media support, audience controls, view receipts, expiration, privacy rules, and moderation hooks.

## Required Features

- create story/status
- attach image/video/media from media module
- text-only status if product allows it
- list stories visible to current user
- get story details
- mark story viewed
- list story viewers for story owner
- delete own story
- expire stories automatically
- audience controls
- muted stories support if product rules require it
- report story
- moderator/admin story removal

## Product Rules To Decide

Document these before implementation:

- story lifetime, default `24h`
- allowed media types and size limits
- text length limit
- max active stories per user
- who can view stories: contacts, everyone, selected users, excluded users
- whether story owner can see viewers
- whether screenshots are tracked, if supported by client
- whether replies to stories create messages

If not specified, use conservative defaults:

- stories expire after 24 hours
- only contacts can view by default
- blocked users can never view each other's stories
- story owner can see viewer list
- stories are soft-deleted/redacted on delete or moderation removal

## Data Model Guidance

Story:

- authorId
- text
- mediaAttachmentIds
- audienceType: `contacts`, `everyone`, `selected`, `except`
- selectedUserIds
- excludedUserIds
- expiresAt
- deletedAt
- deletedBy
- deletionReason
- createdAt
- updatedAt

StoryView:

- storyId
- viewerId
- viewedAt

StoryMute:

- userId
- mutedUserId
- createdAt

## Permission And Privacy Rules

- `member` can create/delete their own stories
- `moderator`, `admin`, and `super-admin` can remove stories only through explicit moderation permission
- viewers must pass audience, contact, privacy, and block checks
- users cannot view stories from users who blocked them
- users cannot view expired or deleted stories
- story owner can view their own story and viewer list
- normal users cannot view another user's viewer list
- attachment access must be authorized through story visibility

## API Routes

```txt
POST   /api/v1/stories
GET    /api/v1/stories
GET    /api/v1/stories/:storyId
POST   /api/v1/stories/:storyId/view
GET    /api/v1/stories/:storyId/viewers
DELETE /api/v1/stories/:storyId
POST   /api/v1/stories/:storyId/report
POST   /api/v1/stories/mutes
DELETE /api/v1/stories/mutes/:userId
```

## Realtime And Notifications

Optional events:

```txt
story.created
story.deleted
story.expired
story.viewed
```

Only notify users who can view the story and have not muted the author.

## Cleanup Job

Add an idempotent story expiration job that:

- marks expired stories
- handles media retention according to policy
- avoids deleting shared attachments incorrectly
- logs safe metadata only

## Validation

Validate:

- text length
- media IDs
- media type
- active story count
- audience type
- selected/excluded user list size
- story ID
- report reason

## Testing

Add tests for:

- create story
- invalid media rejected
- story list respects contacts/privacy/audience
- blocked user cannot view
- expired story hidden
- owner can list viewers
- non-owner cannot list viewers
- delete own story
- moderator removal requires permission
- expiration job is idempotent

## Done Criteria

- stories are private by default
- audience checks are enforced server-side
- expired/deleted stories do not leak
- story media access is protected
- tests pass
