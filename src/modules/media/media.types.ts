// Attachment lifecycle.
//
// pending  -> /upload-url issued, no bytes yet. No conversationId, no message.
// uploaded -> /complete called. Owner-only access until attached.
// attached -> linked to a message. visibility derives from the conversation.
// deleted  -> owner or moderator removed it (soft-delete; bytes scheduled).
// rejected -> orphan cleanup or post-upload validation failure.
export const ATTACHMENT_STATUS = {
  PENDING: 'pending',
  UPLOADED: 'uploaded',
  ATTACHED: 'attached',
  DELETED: 'deleted',
  REJECTED: 'rejected'
} as const;

export type AttachmentStatus =
  (typeof ATTACHMENT_STATUS)[keyof typeof ATTACHMENT_STATUS];

// Until an attachment is linked to a conversation, only the owner can read it.
// Once attached, visibility is scoped to the conversation members. We never
// expose `public` from API today — the slot exists so future story/avatar
// flows have a clear path.
export const ATTACHMENT_VISIBILITY = {
  PRIVATE: 'private',
  CONVERSATION: 'conversation',
  PUBLIC: 'public'
} as const;

export type AttachmentVisibility =
  (typeof ATTACHMENT_VISIBILITY)[keyof typeof ATTACHMENT_VISIBILITY];

// MIME allowlist. The decision to allowlist (not block-list) is deliberate:
// any unknown / niche type that slips through can be weaponized as a
// download-as-execute lure (HTA, MSI variants, registry files, etc.). Adding
// new entries should be conscious.
export const ALLOWED_MIME_TYPES = [
  // Images
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
  // Videos
  'video/mp4',
  'video/quicktime',
  'video/webm',
  // Audio
  'audio/aac',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/webm',
  'audio/wav',
  // Documents
  'application/pdf',
  'text/plain',
  // Common office formats
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
] as const;

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

// Extensions that map cleanly to allowed MIME types. Used to cross-check the
// uploaded filename against the declared MIME — a `evil.exe` masquerading as
// `image/png` is rejected because `.exe` isn't on the list.
export const ALLOWED_EXTENSIONS = new Set<string>([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'heic',
  'heif',
  'mp4',
  'mov',
  'webm',
  'aac',
  'm4a',
  'mp3',
  'ogg',
  'wav',
  'pdf',
  'txt',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx'
]);

// Hard-blocked extensions even if the MIME passes (defence-in-depth — a
// crafted MIME could in theory slip through, this layer doesn't depend on
// MIME at all). Keep in sync with the spec list "block executable file types".
export const BLOCKED_EXTENSIONS = new Set<string>([
  'exe',
  'bat',
  'cmd',
  'com',
  'msi',
  'msp',
  'scr',
  'pif',
  'cpl',
  'hta',
  'jar',
  'js',
  'jse',
  'vb',
  'vbs',
  'vbe',
  'wsf',
  'wsh',
  'ps1',
  'psm1',
  'sh',
  'bash',
  'apk',
  'app',
  'deb',
  'rpm',
  'dmg',
  'iso',
  'reg',
  'lnk',
  'dll',
  'so',
  'dylib'
]);

export const FILENAME_MAX_LENGTH = 255;

export interface AttachmentDto {
  id: string;
  ownerId: string;
  conversationId?: string;
  messageId?: string;
  storageProvider: string;
  storageKey: string;
  // Sanitized client-supplied filename. Never used as a storage key.
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  status: AttachmentStatus;
  visibility: AttachmentVisibility;
  width?: number;
  height?: number;
  durationSeconds?: number;
  checksumSha256?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

// Returned by GET /api/v1/media/:id — pairs the metadata with a short-lived
// signed download URL so the client doesn't have to call a separate endpoint.
export interface AttachmentWithDownloadDto {
  attachment: AttachmentDto;
  download: {
    url: string;
    expiresAt: string;
  };
}

export interface UploadUrlResponseDto {
  attachment: AttachmentDto;
  upload: {
    url: string;
    method: 'PUT' | 'POST';
    headers: Record<string, string>;
    expiresAt: string;
    maxBytes: number;
  };
}
