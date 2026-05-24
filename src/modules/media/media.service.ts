import mongoose, { type Types } from 'mongoose';
import { env } from '../../config/env';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError
} from '../../utils/errors';
import { logger } from '../../utils/logger';
import {
  assertCanAccessAttachment,
  assertCanDeleteAttachment,
  type AuthenticatedActor
} from '../permissions/authorization';
import { ConversationMember } from '../conversations/conversationMember.model';
import { PERMISSIONS } from '../permissions/permissions.constants';
import {
  Attachment,
  toAttachmentDto,
  type AttachmentDocument
} from './attachment.model';
import {
  ATTACHMENT_STATUS,
  ATTACHMENT_VISIBILITY,
  type AttachmentDto,
  type AttachmentWithDownloadDto,
  type UploadUrlResponseDto
} from './media.types';
import {
  __filenameInternals,
  type CompleteUploadInput,
  type CreateUploadUrlInput
} from './media.validation';
import { getStorageProvider } from './storage';

const toObjectId = (id: string): Types.ObjectId => new mongoose.Types.ObjectId(id);

const actorIsMediaModerator = (actor: AuthenticatedActor): boolean =>
  actor.permissions.includes(PERMISSIONS.MEDIA_MODERATE);

const findAttachmentOr404 = async (
  attachmentId: string
): Promise<AttachmentDocument> => {
  const att = await Attachment.findById(attachmentId);
  if (!att) throw new NotFoundError('Attachment not found');
  return att;
};

const findActiveMembership = (
  conversationId: string,
  userId: string
) =>
  ConversationMember.findOne({
    conversationId: toObjectId(conversationId),
    userId: toObjectId(userId),
    leftAt: { $exists: false }
  });

// ---------------------------------------------------------------------------
// Create upload URL
// ---------------------------------------------------------------------------

export const createUploadUrl = async (
  actor: AuthenticatedActor,
  input: CreateUploadUrlInput
): Promise<UploadUrlResponseDto> => {
  if (input.sizeBytes > env.MEDIA_MAX_BYTES) {
    // Defence-in-depth — the Zod schema already enforces this, but if a
    // future schema change drops the bound, fail closed here.
    throw new BadRequestError('File exceeds maximum allowed size');
  }

  const provider = getStorageProvider();
  // Allocate the document first so the storage key can include the
  // attachment id. Status starts as `pending` and only the owner can complete
  // it.
  const attachment = await Attachment.create({
    ownerId: toObjectId(actor.id),
    storageProvider: provider.name,
    // Placeholder; rewritten below once we have an id. We use a temporary
    // unique-per-document value to satisfy the unique index in the brief
    // window before the post-create save lands.
    storageKey: `pending/${new mongoose.Types.ObjectId().toString()}`,
    originalFilename: input.filename,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    status: ATTACHMENT_STATUS.PENDING,
    visibility: ATTACHMENT_VISIBILITY.PRIVATE,
    ...(input.checksumSha256 ? { checksumSha256: input.checksumSha256 } : {}),
    ...(input.width != null ? { width: input.width } : {}),
    ...(input.height != null ? { height: input.height } : {}),
    ...(input.durationSeconds != null
      ? { durationSeconds: input.durationSeconds }
      : {})
  });

  const extension = __filenameInternals.extractExtension(input.filename);
  const storageKey = provider.generateStorageKey({
    attachmentId: (attachment._id as Types.ObjectId).toString(),
    ownerId: actor.id,
    extension
  });

  attachment.storageKey = storageKey;
  await attachment.save();

  const upload = await provider.createUploadUrl({
    storageKey,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    expiresInSeconds: env.MEDIA_UPLOAD_URL_TTL_SECONDS
  });

  return {
    attachment: toAttachmentDto(attachment),
    upload: {
      url: upload.url,
      method: upload.method,
      headers: upload.headers,
      expiresAt: upload.expiresAt.toISOString(),
      maxBytes: env.MEDIA_MAX_BYTES
    }
  };
};

// ---------------------------------------------------------------------------
// Complete upload
// ---------------------------------------------------------------------------

export const completeUpload = async (
  actor: AuthenticatedActor,
  input: CompleteUploadInput
): Promise<AttachmentDto> => {
  const attachment = await findAttachmentOr404(input.attachmentId);

  // Only the owner can complete an upload. Pretending to be missing for
  // anyone else prevents enumeration of other users' pending uploads.
  if (attachment.ownerId.toString() !== actor.id) {
    throw new NotFoundError('Attachment not found');
  }

  // Status transition: pending → uploaded. Anything else is a misuse — already
  // uploaded, attached, deleted, or rejected — and surfacing the existing
  // status would let a client probe lifecycle state. Keep the message generic.
  if (attachment.status !== ATTACHMENT_STATUS.PENDING) {
    throw new BadRequestError('Attachment cannot be completed in its current state');
  }

  // Trust-but-cap the client-reported final size. If they overshoot the
  // limit, reject and mark the attachment so the cleanup job can wipe the
  // bytes. The storage provider's integrity headers are what authoritatively
  // bound a real upload — this is the second layer.
  if (input.sizeBytes != null && input.sizeBytes > env.MEDIA_MAX_BYTES) {
    attachment.status = ATTACHMENT_STATUS.REJECTED;
    await attachment.save();
    throw new BadRequestError('Uploaded file exceeds maximum allowed size');
  }

  attachment.status = ATTACHMENT_STATUS.UPLOADED;
  if (input.sizeBytes != null) attachment.sizeBytes = input.sizeBytes;
  if (input.checksumSha256) attachment.checksumSha256 = input.checksumSha256;
  if (input.width != null) attachment.width = input.width;
  if (input.height != null) attachment.height = input.height;
  if (input.durationSeconds != null) {
    attachment.durationSeconds = input.durationSeconds;
  }
  await attachment.save();

  return toAttachmentDto(attachment);
};

// ---------------------------------------------------------------------------
// Get attachment (metadata + signed download URL)
// ---------------------------------------------------------------------------

export const getAttachmentWithDownload = async (
  actor: AuthenticatedActor,
  attachmentId: string
): Promise<AttachmentWithDownloadDto> => {
  const attachment = await findAttachmentOr404(attachmentId);

  // Deleted attachments are not accessible — neither the metadata nor any
  // download URL. Owners and moderators see the lifecycle via separate admin
  // tooling (10-admin-observability-audit.md).
  if (
    attachment.status === ATTACHMENT_STATUS.DELETED ||
    attachment.status === ATTACHMENT_STATUS.REJECTED
  ) {
    throw new NotFoundError('Attachment not found');
  }

  // For pending/uploaded (not yet attached) attachments, only the owner is
  // allowed. For attached ones, the conversation membership check kicks in.
  if (attachment.status !== ATTACHMENT_STATUS.ATTACHED) {
    if (
      attachment.ownerId.toString() !== actor.id &&
      !actorIsMediaModerator(actor)
    ) {
      throw new NotFoundError('Attachment not found');
    }
  } else {
    const membership = attachment.conversationId
      ? await findActiveMembership(
          attachment.conversationId.toString(),
          actor.id
        )
      : null;
    assertCanAccessAttachment(
      {
        id: (attachment._id as Types.ObjectId).toString(),
        ownerId: attachment.ownerId.toString(),
        conversationId: attachment.conversationId?.toString() ?? null,
        visibility: attachment.visibility
      },
      actor,
      membership
    );
  }

  const provider = getStorageProvider();
  const download = await provider.createDownloadUrl({
    storageKey: attachment.storageKey,
    expiresInSeconds: env.MEDIA_DOWNLOAD_URL_TTL_SECONDS
  });

  return {
    attachment: toAttachmentDto(attachment),
    download: {
      url: download.url,
      expiresAt: download.expiresAt.toISOString()
    }
  };
};

// ---------------------------------------------------------------------------
// Delete attachment
// ---------------------------------------------------------------------------

export const deleteAttachment = async (
  actor: AuthenticatedActor,
  attachmentId: string
): Promise<AttachmentDto> => {
  const attachment = await findAttachmentOr404(attachmentId);

  // Already gone — idempotent. Return the masked DTO without re-deleting.
  if (
    attachment.status === ATTACHMENT_STATUS.DELETED ||
    attachment.status === ATTACHMENT_STATUS.REJECTED
  ) {
    return toAttachmentDto(attachment);
  }

  assertCanDeleteAttachment(
    {
      id: (attachment._id as Types.ObjectId).toString(),
      ownerId: attachment.ownerId.toString(),
      conversationId: attachment.conversationId?.toString() ?? null,
      visibility: attachment.visibility
    },
    actor
  );

  attachment.status = ATTACHMENT_STATUS.DELETED;
  attachment.deletedAt = new Date();
  attachment.deletedBy = toObjectId(actor.id);
  await attachment.save();

  // Best-effort object removal. We don't fail the request if the provider
  // delete throws — the orphan cleanup sweep can pick it up later, and we
  // would rather the metadata reflect "deleted" than crash the API call.
  const provider = getStorageProvider();
  provider.deleteObject(attachment.storageKey).catch((err) => {
    logger.warn(
      { err, attachmentId: attachment._id?.toString() },
      'media: storage object delete failed; will be retried by cleanup'
    );
  });

  return toAttachmentDto(attachment);
};

// ---------------------------------------------------------------------------
// Attach to message (called from the messages module)
// ---------------------------------------------------------------------------

export interface AttachToMessageParams {
  attachmentIds: string[];
  conversationId: string;
  messageId: string;
  actor: AuthenticatedActor;
}

/**
 * Atomically transition a batch of uploaded attachments into the `attached`
 * state for a specific message. Returns the resulting documents so the
 * caller (message.service.sendMessage) can include them in the response.
 *
 * Authorization rules — must all hold for every attachment in the batch:
 *   1. Owned by `actor`. No cross-user attachment.
 *   2. status === 'uploaded'. Pending uploads must complete first; attached
 *      ones cannot be reattached; deleted/rejected ones are off-limits.
 *   3. conversationId either unset OR already equal to the target. This
 *      prevents an attachment that was completed against one conversation
 *      from being silently moved to another.
 *
 * Membership in the target conversation is the caller's responsibility — by
 * the time we're here, the message has already been authorized to be sent.
 */
export const attachToMessage = async (
  params: AttachToMessageParams
): Promise<AttachmentDocument[]> => {
  const { attachmentIds, conversationId, messageId, actor } = params;
  if (attachmentIds.length === 0) return [];
  if (attachmentIds.length > env.MEDIA_MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new BadRequestError('Too many attachments for one message');
  }

  // Dedupe before the lookup. A repeated id in the input list would otherwise
  // produce a confusing error in the membership-check loop below.
  const uniqueIds = Array.from(new Set(attachmentIds));
  if (uniqueIds.length !== attachmentIds.length) {
    throw new BadRequestError('Duplicate attachment ids');
  }

  const docs = await Attachment.find({
    _id: { $in: uniqueIds.map(toObjectId) }
  });
  if (docs.length !== uniqueIds.length) {
    throw new BadRequestError('One or more attachments do not exist');
  }

  // Single pass to enforce ownership / status / conversation-binding. We do
  // not lazy-throw inside the update loop — every check happens before the
  // first write so we never leave the batch half-attached.
  for (const att of docs) {
    if (att.ownerId.toString() !== actor.id) {
      throw new ForbiddenError('You do not own one or more attachments');
    }
    if (att.status !== ATTACHMENT_STATUS.UPLOADED) {
      throw new BadRequestError(
        'One or more attachments are not ready to be attached'
      );
    }
    if (
      att.conversationId &&
      att.conversationId.toString() !== conversationId
    ) {
      throw new ForbiddenError(
        'One or more attachments belong to a different conversation'
      );
    }
  }

  const convOid = toObjectId(conversationId);
  const msgOid = toObjectId(messageId);

  const attached: AttachmentDocument[] = [];
  for (const att of docs) {
    // Guarded update: only flip if still UPLOADED. A concurrent attach
    // attempt loses the race rather than overwriting the winner's binding.
    const updated = await Attachment.findOneAndUpdate(
      {
        _id: att._id,
        ownerId: toObjectId(actor.id),
        status: ATTACHMENT_STATUS.UPLOADED
      },
      {
        $set: {
          status: ATTACHMENT_STATUS.ATTACHED,
          visibility: ATTACHMENT_VISIBILITY.CONVERSATION,
          conversationId: convOid,
          messageId: msgOid
        }
      },
      { new: true }
    );
    if (!updated) {
      throw new BadRequestError(
        'One or more attachments were modified concurrently'
      );
    }
    attached.push(updated);
  }

  return attached;
};

// ---------------------------------------------------------------------------
// Orphan cleanup
// ---------------------------------------------------------------------------

export interface CleanupOrphanedAttachmentsResult {
  scanned: number;
  rejected: number;
}

export const cleanupOrphanedAttachments = async (
  now: Date = new Date(),
  ttlSeconds: number = env.MEDIA_PENDING_TTL_SECONDS,
  batchSize = 200
): Promise<CleanupOrphanedAttachmentsResult> => {
  const cutoff = new Date(now.getTime() - ttlSeconds * 1000);
  const candidates = await Attachment.find({
    status: ATTACHMENT_STATUS.PENDING,
    createdAt: { $lt: cutoff }
  })
    .sort({ createdAt: 1 })
    .limit(batchSize);

  let rejected = 0;
  for (const att of candidates) {
    const updated = await Attachment.findOneAndUpdate(
      { _id: att._id, status: ATTACHMENT_STATUS.PENDING },
      { $set: { status: ATTACHMENT_STATUS.REJECTED } },
      { new: true }
    );
    if (!updated) continue;
    rejected += 1;

    // Best-effort: delete the (possibly never-uploaded) underlying object.
    const provider = getStorageProvider();
    provider.deleteObject(att.storageKey).catch((err) => {
      logger.warn(
        { err, attachmentId: att._id?.toString() },
        'media cleanup: storage object delete failed'
      );
    });
  }

  if (rejected > 0) {
    logger.info(
      { scanned: candidates.length, rejected },
      'media cleanup: batch complete'
    );
  }
  return { scanned: candidates.length, rejected };
};
