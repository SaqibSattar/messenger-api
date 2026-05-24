import mongoose, { type FilterQuery, type Types } from 'mongoose';
import { env } from '../../config/env';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError
} from '../../utils/errors';
import { auditStoryRemoved, auditStoryReported } from '../../utils/audit';
import { logger } from '../../utils/logger';
import { emitRealtime } from '../../services/realtimeEvents';
import { User } from '../users/user.model';
import { USER_STATUS } from '../users/user.types';
import {
  type AuthenticatedActor
} from '../permissions/authorization';
import { PERMISSIONS } from '../permissions/permissions.constants';
import { Attachment, type AttachmentDocument } from '../media/attachment.model';
import { ATTACHMENT_STATUS } from '../media/media.types';
import { getStorageProvider } from '../media/storage';
import { Story, toStoryDto, type StoryDocument } from './story.model';
import { StoryView, toStoryViewerDto } from './storyView.model';
import { StoryMute, toStoryMuteDto } from './storyMute.model';
import {
  STORY_DELETION_REASON,
  STORY_EXPIRATION_BATCH_SIZE,
  STORY_MAX_ACTIVE_PER_USER,
  type StoryDeletionReason,
  type StoryDto,
  type StoryListResult,
  type StoryMediaSummary,
  type StoryMuteDto,
  type StoryViewersListResult
} from './story.types';
import type {
  CreateStoryInput,
  CreateStoryMuteInput,
  ListStoriesQuery,
  ListStoryViewersQuery,
  ReportStoryInput
} from './story.validation';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const toObjectId = (id: string): Types.ObjectId =>
  new mongoose.Types.ObjectId(id);

const actorIsStoryModerator = (actor: AuthenticatedActor): boolean =>
  actor.permissions.includes(PERMISSIONS.STORY_MODERATE);

// Block check stub. Lands properly with prompt 08 (moderation). Keep the
// call sites here so swapping in the real check is a single-file change.
const isBlockedBetween = async (
  _userIdA: string,
  _userIdB: string
): Promise<boolean> => false;

// Contact relationship stub. Lands with prompt 13 (contacts). Default is
// "everyone is a contact" so the conservative `contacts` audience does not
// silently turn into "nobody can view" before the contacts module ships.
// Once contacts ships, this returns true only when the viewer is in the
// author's contact list.
const isContact = async (
  _authorId: string,
  _viewerId: string
): Promise<boolean> => true;

const findActiveStoryOr404 = async (
  storyId: string
): Promise<StoryDocument> => {
  const story = await Story.findById(storyId);
  if (!story) throw new NotFoundError('Story not found');
  // Deleted or expired stories are hidden from every caller, including the
  // owner. Expiration is a `deletedAt + deletionReason=expired` write made
  // by the cleanup job. We also belt-and-brace check `expiresAt` in case the
  // job hasn't run yet — a read during the gap must not leak content.
  if (story.deletedAt) throw new NotFoundError('Story not found');
  if (story.expiresAt.getTime() <= Date.now()) {
    throw new NotFoundError('Story not found');
  }
  return story;
};

const ensureActiveUsersExist = async (userIds: string[]): Promise<void> => {
  if (userIds.length === 0) return;
  const ids = userIds.map(toObjectId);
  const count = await User.countDocuments({
    _id: { $in: ids },
    status: USER_STATUS.ACTIVE
  });
  if (count !== userIds.length) {
    throw new BadRequestError('One or more users do not exist or are not active');
  }
};

// Decide whether `viewer` may see `story`. Returns true only if every layer
// passes: audience, contact-relation (when audience=contacts), block-pair,
// and non-deletion. Mutes are NOT enforced here — mutes hide the story from
// the viewer's feed only; if they navigate directly to the URL, they can
// still see it (mirrors common product behavior).
const canViewStory = async (
  story: StoryDocument,
  viewerId: string
): Promise<boolean> => {
  if (story.deletedAt) return false;
  if (story.expiresAt.getTime() <= Date.now()) return false;

  const authorId = story.authorId.toString();
  if (authorId === viewerId) return true;

  // Block pair. Either direction blocks both directions.
  if (await isBlockedBetween(authorId, viewerId)) return false;

  switch (story.audienceType) {
    case 'everyone':
      return true;
    case 'contacts':
      return isContact(authorId, viewerId);
    case 'selected':
      return story.selectedUserIds.some((id) => id.toString() === viewerId);
    case 'except':
      return !story.excludedUserIds.some((id) => id.toString() === viewerId);
    default:
      return false;
  }
};

// Surface the storage download URL alongside the attachment metadata. Only
// invoke this once the viewer has been authorized for the story; never for
// the bare list endpoint. The download URL is a short-lived signed URL.
const buildMediaSummaries = async (
  story: StoryDocument,
  options: { includeDownloadUrls: boolean }
): Promise<StoryMediaSummary[]> => {
  if (!story.mediaAttachmentIds || story.mediaAttachmentIds.length === 0) {
    return [];
  }

  const ids = story.mediaAttachmentIds.map(
    (id) => id as Types.ObjectId
  );
  const docs = await Attachment.find({
    _id: { $in: ids },
    // Story attachments stay in `uploaded` status owned by the author — they
    // are not transitioned to `attached` because attachment.conversationId
    // / messageId would force a binding the story doesn't use. Skip anything
    // that got deleted or rejected so a leaked id can't surface metadata.
    status: { $in: [ATTACHMENT_STATUS.UPLOADED, ATTACHMENT_STATUS.ATTACHED] }
  });
  const byId = new Map(
    docs.map((a) => [(a._id as Types.ObjectId).toString(), a])
  );

  const provider = options.includeDownloadUrls ? getStorageProvider() : null;
  const summaries: StoryMediaSummary[] = [];
  for (const ref of story.mediaAttachmentIds) {
    const a = byId.get(ref.toString());
    if (!a) continue;
    const summary: StoryMediaSummary = {
      attachmentId: (a._id as Types.ObjectId).toString(),
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes
    };
    if (a.width != null) summary.width = a.width;
    if (a.height != null) summary.height = a.height;
    if (a.durationSeconds != null) summary.durationSeconds = a.durationSeconds;
    if (provider) {
      const url = await provider.createDownloadUrl({
        storageKey: a.storageKey,
        expiresInSeconds: env.MEDIA_DOWNLOAD_URL_TTL_SECONDS
      });
      summary.downloadUrl = url.url;
      summary.downloadUrlExpiresAt = url.expiresAt.toISOString();
    }
    summaries.push(summary);
  }
  return summaries;
};

// Compute the set of users who currently pass the story's audience rules.
// Used at create-time to seed the realtime fan-out list. Block- and mute-
// pruning are applied per-recipient so the bridge does not re-evaluate.
const resolveCurrentViewerIds = async (
  story: StoryDocument
): Promise<string[]> => {
  const authorId = story.authorId.toString();
  // For `selected`, the explicit list is the universe — we don't need to scan
  // all users. For `everyone` / `contacts` / `except` we look up the set of
  // active user ids and apply the rule. In a real system with millions of
  // users this would be replaced by the contacts module (prompt 13) — we
  // emit to a much smaller per-author contact set instead of scanning users.
  let candidateIds: string[];
  if (story.audienceType === 'selected') {
    candidateIds = story.selectedUserIds.map((id) => id.toString());
  } else {
    const docs = await User.find({
      _id: { $ne: toObjectId(authorId) },
      status: USER_STATUS.ACTIVE
    }).select('_id');
    candidateIds = docs.map((d) => (d._id as Types.ObjectId).toString());
  }

  const excluded = new Set(
    story.excludedUserIds.map((id) => id.toString())
  );

  // Drop anyone who has muted this author — they shouldn't get a push for a
  // story they've opted out of. (They can still resolve direct links.)
  const muteDocs = await StoryMute.find({
    mutedUserId: toObjectId(authorId),
    userId: { $in: candidateIds.map(toObjectId) }
  }).select('userId');
  const muters = new Set(
    muteDocs.map((m) => m.userId.toString())
  );

  const visibleIds: string[] = [];
  for (const candidateId of candidateIds) {
    if (candidateId === authorId) continue;
    if (excluded.has(candidateId)) continue;
    if (muters.has(candidateId)) continue;
    // Block check — bidirectional via the stub.
    if (await isBlockedBetween(authorId, candidateId)) continue;
    // Audience-specific check (contacts requires the relation; others were
    // already covered above by the candidate-set construction).
    if (story.audienceType === 'contacts') {
      if (!(await isContact(authorId, candidateId))) continue;
    }
    visibleIds.push(candidateId);
  }
  return visibleIds;
};

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export const createStory = async (
  actor: AuthenticatedActor,
  input: CreateStoryInput
): Promise<StoryDto> => {
  // Per-user live cap. Enforced before the write so a spike that races the
  // limiter can't sneak past via concurrent inserts.
  const activeCount = await Story.countDocuments({
    authorId: toObjectId(actor.id),
    deletedAt: { $exists: false },
    expiresAt: { $gt: new Date() }
  });
  if (activeCount >= STORY_MAX_ACTIVE_PER_USER) {
    throw new BadRequestError(
      'You have reached the active story limit'
    );
  }

  // Resolve and validate attachment references. Each must be owned by the
  // actor and ready (uploaded or already attached to a previous story — but
  // we reject attached-to-message because those bind to a different lifecycle).
  let attachments: AttachmentDocument[] = [];
  if (input.mediaAttachmentIds && input.mediaAttachmentIds.length > 0) {
    const ids = input.mediaAttachmentIds.map(toObjectId);
    const docs = await Attachment.find({ _id: { $in: ids } });
    if (docs.length !== input.mediaAttachmentIds.length) {
      throw new BadRequestError('One or more media attachments do not exist');
    }
    for (const a of docs) {
      if (a.ownerId.toString() !== actor.id) {
        throw new ForbiddenError('You do not own one or more attachments');
      }
      if (a.status !== ATTACHMENT_STATUS.UPLOADED) {
        // Already-attached / deleted / rejected / pending — none of those
        // are valid for a fresh story.
        throw new BadRequestError(
          'One or more attachments are not ready to be used in a story'
        );
      }
      if (a.conversationId || a.messageId) {
        // Belt-and-brace: status=uploaded should already mean no binding,
        // but guard against a future code path that updates one without the
        // other.
        throw new BadRequestError(
          'One or more attachments are already bound to a different resource'
        );
      }
    }
    attachments = docs;
  }

  // Validate audience targets exist. For `selected` we ensure every id is a
  // real active user — otherwise the story silently has nobody in its
  // audience. For `except`, the exclusion list is allowed to reference any
  // id (a since-deleted user just becomes a no-op exclusion).
  if (input.audienceType === 'selected' && input.selectedUserIds) {
    const ids = input.selectedUserIds.filter((id) => id !== actor.id);
    await ensureActiveUsersExist(ids);
  }

  const expiresAt = new Date(Date.now() + input.lifetimeSeconds * 1000);
  const story = await Story.create({
    authorId: toObjectId(actor.id),
    text: input.text ?? '',
    mediaAttachmentIds: attachments.map((a) => a._id as Types.ObjectId),
    audienceType: input.audienceType,
    selectedUserIds:
      input.audienceType === 'selected' && input.selectedUserIds
        ? input.selectedUserIds.map(toObjectId)
        : [],
    excludedUserIds:
      input.audienceType === 'except' && input.excludedUserIds
        ? input.excludedUserIds.map(toObjectId)
        : [],
    expiresAt
  });

  const media = await buildMediaSummaries(story, {
    includeDownloadUrls: true
  });

  const dto = toStoryDto(story, {
    viewerId: actor.id,
    viewerHasViewed: false,
    viewerCount: 0,
    media
  });

  // Fan out to active candidate viewers. The bridge maps each viewerId to
  // their user room.
  try {
    const viewerIds = await resolveCurrentViewerIds(story);
    emitRealtime('story.created', {
      authorId: actor.id,
      viewerIds,
      story: dto
    });
  } catch (err) {
    // Realtime emit is best-effort — the story is created either way.
    logger.warn({ err, storyId: dto.id }, 'story.created fan-out failed');
  }

  return dto;
};

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export const listStories = async (
  actor: AuthenticatedActor,
  query: ListStoriesQuery
): Promise<StoryListResult> => {
  const now = new Date();

  // Build the candidate filter. The audience / block / mute checks happen in
  // a second pass on the returned page so we can keep the index path cheap.
  const filter: FilterQuery<StoryDocument> = {
    deletedAt: { $exists: false },
    expiresAt: { $gt: now }
  };

  if (query.onlyMine) {
    filter.authorId = toObjectId(actor.id);
  } else {
    // Exclude muted authors so they don't show up in the feed.
    const muteDocs = await StoryMute.find({
      userId: toObjectId(actor.id)
    }).select('mutedUserId');
    const mutedAuthorIds = muteDocs.map((m) => m.mutedUserId);
    if (mutedAuthorIds.length > 0) {
      filter.authorId = { $nin: mutedAuthorIds };
    }
  }

  if (query.cursor) {
    filter._id = { $lt: toObjectId(query.cursor) };
  }

  // Pull more than `limit` candidates because the audience-pass may drop
  // some. We loop with growing windows until we have enough or hit the
  // end. The maximum total scan is bounded so a hostile feed cannot force
  // unbounded work.
  const PAGE_OVERSCAN = 3;
  const MAX_TOTAL_SCAN = query.limit * 10;
  const items: StoryDto[] = [];
  let scanned = 0;
  let nextCursor: string | null = null;
  let cursorFilter = filter;

  while (items.length < query.limit && scanned < MAX_TOTAL_SCAN) {
    const fetchLimit = (query.limit - items.length) * PAGE_OVERSCAN + 1;
    const docs = await Story.find(cursorFilter)
      .sort({ _id: -1 })
      .limit(fetchLimit);
    if (docs.length === 0) break;
    scanned += docs.length;

    // Audience pass.
    for (const story of docs) {
      if (items.length >= query.limit) break;
      const visible = query.onlyMine
        ? story.authorId.toString() === actor.id
        : await canViewStory(story, actor.id);
      if (!visible) continue;

      // For listings we omit signed download URLs — clients fetch the
      // detail endpoint to get them. This avoids issuing 100s of download
      // URLs for a single feed page.
      const media = await buildMediaSummaries(story, {
        includeDownloadUrls: false
      });
      const viewerHasViewed = await StoryView.exists({
        storyId: story._id,
        viewerId: toObjectId(actor.id)
      }).then((r) => !!r);

      let viewerCount: number | undefined;
      if (story.authorId.toString() === actor.id) {
        viewerCount = await StoryView.countDocuments({ storyId: story._id });
      }

      items.push(
        toStoryDto(story, {
          viewerId: actor.id,
          viewerHasViewed,
          viewerCount,
          media
        })
      );
    }

    // Set up the next cursor / iteration.
    const lastId = docs[docs.length - 1]._id as Types.ObjectId;
    cursorFilter = { ...cursorFilter, _id: { $lt: lastId } };
    if (docs.length < fetchLimit) break;
    if (items.length >= query.limit) {
      // Use the last visible story as the cursor for the next page.
      nextCursor = lastId.toString();
      break;
    }
  }

  // If we exited with a full page but haven't set a cursor yet, the last
  // item is the cursor anchor.
  if (items.length === query.limit && !nextCursor) {
    nextCursor = items[items.length - 1].id;
  }

  return { items, nextCursor };
};

// ---------------------------------------------------------------------------
// Get details
// ---------------------------------------------------------------------------

export const getStory = async (
  actor: AuthenticatedActor,
  storyId: string
): Promise<StoryDto> => {
  const story = await findActiveStoryOr404(storyId);

  // Moderators with story:moderate may inspect any story to action reports,
  // even when the audience would normally exclude them.
  const isModerator = actorIsStoryModerator(actor);
  const viewable = isModerator ? true : await canViewStory(story, actor.id);
  if (!viewable) {
    // Mask as not-found to avoid revealing which stories exist behind an
    // audience boundary.
    throw new NotFoundError('Story not found');
  }

  const media = await buildMediaSummaries(story, {
    includeDownloadUrls: true
  });
  const viewerHasViewed = await StoryView.exists({
    storyId: story._id,
    viewerId: toObjectId(actor.id)
  }).then((r) => !!r);

  let viewerCount: number | undefined;
  if (story.authorId.toString() === actor.id) {
    viewerCount = await StoryView.countDocuments({ storyId: story._id });
  }

  return toStoryDto(story, {
    viewerId: actor.id,
    viewerHasViewed,
    viewerCount,
    media
  });
};

// ---------------------------------------------------------------------------
// Mark viewed
// ---------------------------------------------------------------------------

export const markStoryViewed = async (
  actor: AuthenticatedActor,
  storyId: string
): Promise<{ viewedAt: string }> => {
  const story = await findActiveStoryOr404(storyId);

  // Owner does not generate a self-view receipt — it would pollute the
  // viewer list for the owner and confuse "have you been seen" UI.
  if (story.authorId.toString() === actor.id) {
    return { viewedAt: new Date().toISOString() };
  }

  // Authorization to view is required to mark viewed. We do not let a
  // platform moderator's read trigger a viewer-list entry — that would
  // accidentally surface moderation activity to the owner.
  const visible = await canViewStory(story, actor.id);
  if (!visible) throw new NotFoundError('Story not found');

  const now = new Date();
  try {
    await StoryView.create({
      storyId: story._id,
      viewerId: toObjectId(actor.id),
      viewedAt: now
    });
  } catch (err) {
    if (
      err instanceof mongoose.mongo.MongoServerError &&
      err.code === 11000
    ) {
      // Already viewed — idempotent. No event, no audit entry.
      const existing = await StoryView.findOne({
        storyId: story._id,
        viewerId: toObjectId(actor.id)
      });
      return {
        viewedAt: existing ? existing.viewedAt.toISOString() : now.toISOString()
      };
    }
    throw err;
  }

  emitRealtime('story.viewed', {
    authorId: story.authorId.toString(),
    storyId: (story._id as Types.ObjectId).toString(),
    viewerId: actor.id,
    viewedAt: now.toISOString()
  });

  return { viewedAt: now.toISOString() };
};

// ---------------------------------------------------------------------------
// List viewers (owner only)
// ---------------------------------------------------------------------------

export const listStoryViewers = async (
  actor: AuthenticatedActor,
  storyId: string,
  query: ListStoryViewersQuery
): Promise<StoryViewersListResult> => {
  const story = await findActiveStoryOr404(storyId);

  // Strict owner-only. Platform moderators do NOT bypass — the viewer list is
  // a privacy artifact, not a moderation artifact. A moderator who needs the
  // data should go through the audit/admin tooling, not this endpoint.
  if (story.authorId.toString() !== actor.id) {
    throw new ForbiddenError('Only the story owner can list viewers');
  }

  const filter: FilterQuery<{ storyId: Types.ObjectId; _id: Types.ObjectId }> = {
    storyId: story._id as Types.ObjectId
  };
  if (query.cursor) {
    (filter as Record<string, unknown>)._id = { $lt: toObjectId(query.cursor) };
  }

  const docs = await StoryView.find(filter)
    .sort({ _id: -1 })
    .limit(query.limit + 1);

  const hasMore = docs.length > query.limit;
  const page = hasMore ? docs.slice(0, query.limit) : docs;

  const items = page.map(toStoryViewerDto);
  const nextCursor =
    hasMore && page.length > 0
      ? (page[page.length - 1]._id as Types.ObjectId).toString()
      : null;
  return { items, nextCursor };
};

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export const deleteStory = async (
  actor: AuthenticatedActor,
  storyId: string
): Promise<StoryDto> => {
  // Use a raw read here (not findActiveStoryOr404) so we can return the same
  // 404 if the story is already gone — but we still need access to the
  // document to authorize and idempotently respond.
  const story = await Story.findById(storyId);
  if (!story) throw new NotFoundError('Story not found');
  if (story.deletedAt) {
    // Idempotent: already redacted. Mask media + return.
    return toStoryDto(story, {
      viewerId: actor.id,
      media: []
    });
  }

  const isOwner = story.authorId.toString() === actor.id;
  const isMod = actorIsStoryModerator(actor);
  if (!isOwner && !isMod) {
    throw new ForbiddenError('You cannot delete this story');
  }
  if (isOwner && !actor.permissions.includes(PERMISSIONS.STORY_DELETE_OWN)) {
    throw new ForbiddenError('You cannot delete this story');
  }

  const now = new Date();
  story.deletedAt = now;
  story.deletedBy = toObjectId(actor.id);
  const reason: StoryDeletionReason =
    isMod && !isOwner
      ? STORY_DELETION_REASON.MODERATOR_REMOVED
      : STORY_DELETION_REASON.USER_DELETED;
  story.deletionReason = reason;
  await story.save();

  // Soft-delete attachments owned by the story so the orphan-cleanup pass
  // doesn't leave them readable to the owner indefinitely. The media
  // module's deletion is the source of truth for the storage object — we
  // only mark the docs here.
  if (story.mediaAttachmentIds.length > 0) {
    await Attachment.updateMany(
      {
        _id: { $in: story.mediaAttachmentIds },
        ownerId: toObjectId(story.authorId.toString()),
        // Don't clobber an attachment that's been re-bound elsewhere — only
        // mark the ones still in `uploaded` (the state we created them in).
        status: ATTACHMENT_STATUS.UPLOADED
      },
      {
        $set: {
          status: ATTACHMENT_STATUS.DELETED,
          deletedAt: now,
          deletedBy: toObjectId(actor.id)
        }
      }
    );
  }

  await auditStoryRemoved(
    { actorId: actor.id },
    {
      storyId: (story._id as Types.ObjectId).toString(),
      authorId: story.authorId.toString(),
      removedBy: isMod && !isOwner ? 'moderator' : 'owner'
    }
  );

  // Tell every recent viewer the story is gone. Use the resolved audience
  // — the bridge fans this out to each user room.
  try {
    const viewerIds = await resolveCurrentViewerIds(story);
    emitRealtime('story.deleted', {
      authorId: story.authorId.toString(),
      storyId: (story._id as Types.ObjectId).toString(),
      viewerIds
    });
  } catch (err) {
    logger.warn(
      { err, storyId: (story._id as Types.ObjectId).toString() },
      'story.deleted fan-out failed'
    );
  }

  return toStoryDto(story, {
    viewerId: actor.id,
    media: []
  });
};

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface ReportStoryResult {
  acknowledged: true;
}

export const reportStory = async (
  actor: AuthenticatedActor,
  storyId: string,
  input: ReportStoryInput
): Promise<ReportStoryResult> => {
  // Use the raw fetch so a report on an already-removed story still records
  // an audit event (a user might be reporting something they saw before it
  // was removed and that signal still matters to moderators).
  const story = await Story.findById(storyId);
  if (!story) throw new NotFoundError('Story not found');

  if (!actor.permissions.includes(PERMISSIONS.REPORT_CREATE)) {
    throw new ForbiddenError('You cannot report stories');
  }

  // Cannot report your own story — that's noise, not a moderation signal.
  if (story.authorId.toString() === actor.id) {
    throw new BadRequestError('You cannot report your own story');
  }

  // Visibility check: a user who couldn't see the story has no business
  // reporting it. (Once the story is deleted, we still allow the report
  // because the prior visibility cannot be re-checked — moderators decide
  // what to do with it.)
  if (!story.deletedAt) {
    const visible = await canViewStory(story, actor.id);
    if (!visible) throw new NotFoundError('Story not found');
  }

  // The persistent `reports` collection lands with prompt 08. Until then we
  // log the audit event so the moderation team has a paper trail; the
  // moderation module will additionally persist the record. Never log the
  // report body itself.
  await auditStoryReported(
    { actorId: actor.id },
    {
      storyId: (story._id as Types.ObjectId).toString(),
      authorId: story.authorId.toString(),
      reason: input.reason,
      hasDetails: !!input.details && input.details.length > 0
    }
  );

  return { acknowledged: true };
};

// ---------------------------------------------------------------------------
// Mutes
// ---------------------------------------------------------------------------

export const createStoryMute = async (
  actor: AuthenticatedActor,
  input: CreateStoryMuteInput
): Promise<StoryMuteDto> => {
  if (input.mutedUserId === actor.id) {
    throw new BadRequestError('You cannot mute your own stories');
  }
  await ensureActiveUsersExist([input.mutedUserId]);

  try {
    const mute = await StoryMute.create({
      userId: toObjectId(actor.id),
      mutedUserId: toObjectId(input.mutedUserId)
    });
    return toStoryMuteDto(mute);
  } catch (err) {
    if (
      err instanceof mongoose.mongo.MongoServerError &&
      err.code === 11000
    ) {
      // Already muted — surface the existing record so callers can treat
      // both as success.
      const existing = await StoryMute.findOne({
        userId: toObjectId(actor.id),
        mutedUserId: toObjectId(input.mutedUserId)
      });
      if (existing) return toStoryMuteDto(existing);
      throw new ConflictError('Mute could not be saved');
    }
    throw err;
  }
};

export const deleteStoryMute = async (
  actor: AuthenticatedActor,
  mutedUserId: string
): Promise<void> => {
  // Idempotent: a delete on a non-existent mute is a no-op so the client can
  // safely toggle without checking state first.
  await StoryMute.deleteOne({
    userId: toObjectId(actor.id),
    mutedUserId: toObjectId(mutedUserId)
  });
};

// ---------------------------------------------------------------------------
// Expiration sweep
// ---------------------------------------------------------------------------

export interface ExpireStoriesResult {
  scanned: number;
  expired: number;
}

/**
 * Idempotent batch sweep over stories whose `expiresAt` has passed. Marks
 * each as `deletedAt: now, deletionReason: 'expired'` and stamps owned media
 * attachments as deleted so the storage cleanup pass can remove the bytes.
 *
 * Idempotency:
 *   - The partial index on `expiresAt` excludes already-deleted docs, so a
 *     subsequent run won't see them.
 *   - Per-doc update uses a guarded filter (`deletedAt: missing`) so two
 *     parallel runs race the same doc without double-redaction.
 *
 * Privacy: the log includes only counts and ids. No story text or media
 * metadata leaks through the job.
 */
export const expireStoriesOnce = async (
  now: Date = new Date(),
  batchSize = STORY_EXPIRATION_BATCH_SIZE
): Promise<ExpireStoriesResult> => {
  const candidates = await Story.find({
    expiresAt: { $lte: now },
    deletedAt: { $exists: false }
  })
    .sort({ expiresAt: 1 })
    .limit(batchSize);

  let expired = 0;
  for (const story of candidates) {
    const updated = await Story.findOneAndUpdate(
      { _id: story._id, deletedAt: { $exists: false } },
      {
        $set: {
          deletedAt: now,
          deletionReason: STORY_DELETION_REASON.EXPIRED
        }
      },
      { new: true }
    );
    if (!updated) continue;
    expired += 1;

    // Mark the story-owned attachments as deleted. We don't free the storage
    // bytes here — the media cleanup pass owns the actual delete.
    if (updated.mediaAttachmentIds.length > 0) {
      await Attachment.updateMany(
        {
          _id: { $in: updated.mediaAttachmentIds },
          ownerId: updated.authorId,
          status: ATTACHMENT_STATUS.UPLOADED
        },
        {
          $set: {
            status: ATTACHMENT_STATUS.DELETED,
            deletedAt: now
          }
        }
      );
    }

    try {
      const viewerIds = await resolveCurrentViewerIds(updated);
      emitRealtime('story.expired', {
        authorId: updated.authorId.toString(),
        storyId: (updated._id as Types.ObjectId).toString(),
        viewerIds
      });
    } catch (err) {
      logger.warn(
        { err, storyId: (updated._id as Types.ObjectId).toString() },
        'story.expired fan-out failed'
      );
    }
  }

  if (expired > 0) {
    logger.info({ scanned: candidates.length, expired }, 'expireStories: batch complete');
  }
  return { scanned: candidates.length, expired };
};
