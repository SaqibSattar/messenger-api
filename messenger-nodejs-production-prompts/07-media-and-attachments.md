# Prompt 07: Media And Attachments

You are an expert backend engineer building secure media upload and attachment handling.

Inspect the current project first and follow existing storage patterns.

## Goal

Build production-safe media upload, metadata storage, authorization, and attachment support for messages.

## Required Features

- request upload permission or signed upload URL
- upload metadata creation
- attachment linking to messages
- private attachment access checks
- attachment delete/archive
- optional thumbnail metadata
- optional virus scanning hook placeholder

## Storage Guidance

Use object storage such as S3, Cloudinary, or the configured provider.

Do not store production files on the application server disk except temporary processing with cleanup.

## Data Model Guidance

Attachment:

- ownerId
- conversationId optional until attached
- messageId optional after attached
- storageProvider
- storageKey
- url or signed URL metadata
- originalFilename sanitized
- mimeType
- sizeBytes
- width/height/duration when applicable
- checksum when available
- status: `pending`, `uploaded`, `attached`, `deleted`, `rejected`
- createdAt
- deletedAt

## Security Rules

- validate file size
- validate MIME type
- validate extension
- block executable file types
- generate server-side storage keys
- never trust client filenames
- authorize access before returning private URLs
- use signed URLs or proxy downloads for private files
- clean up orphaned pending uploads
- limit number of attachments per message
- scan files for malware when available
- strip metadata when privacy matters

## API Routes

```txt
POST   /api/v1/media/upload-url
POST   /api/v1/media/complete
GET    /api/v1/media/:attachmentId
DELETE /api/v1/media/:attachmentId
```

## Validation

Validate:

- MIME type
- size
- filename length
- extension
- attachment ID
- conversation ID when provided
- upload status transitions

## Testing

Add tests for:

- blocked MIME type
- file too large
- unauthorized access to private attachment
- owner can access
- non-member cannot access conversation attachment
- attachment cannot be linked across unauthorized conversation
- orphan cleanup if implemented

## Done Criteria

- uploads cannot bypass validation
- private media cannot leak
- attachment metadata is safe
- docs and tests are updated
