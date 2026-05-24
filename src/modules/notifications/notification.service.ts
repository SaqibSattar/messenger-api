import mongoose, { type FilterQuery, type Types } from 'mongoose';
import { ForbiddenError, NotFoundError } from '../../utils/errors';
import { enqueuePushNotification } from '../../jobs/pushNotificationJob';
import {
  assertCanAccessNotification,
  assertConversationMembership,
  type AuthenticatedActor
} from '../permissions/authorization';
import { ConversationMember } from '../conversations/conversationMember.model';
import {
  Notification,
  toNotificationDto,
  type NotificationDocument
} from './notification.model';
import {
  NotificationPreference,
  toNotificationPreferencesDto,
  type NotificationPreferenceDocument
} from './notificationPreference.model';
import {
  ConversationNotificationPreference,
  toConversationNotificationPreferenceDto
} from './conversationNotificationPreference.model';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_BODY_PREVIEW_MAX_LENGTH,
  NOTIFICATION_TITLE_MAX_LENGTH,
  NOTIFICATION_TYPE,
  QUIET_HOURS_MINUTES_PER_DAY,
  type ConversationNotificationPreferenceDto,
  type CreateNotificationInput,
  type ListNotificationsResult,
  type NotificationDto,
  type NotificationPreferencesDto,
  type QuietHoursDto
} from './notification.types';
import type {
  ListNotificationsQuery,
  UpdateConversationNotificationPreferenceInput,
  UpdateNotificationPreferencesInput
} from './notification.validation';

const toObjectId = (id: string): Types.ObjectId =>
  new mongoose.Types.ObjectId(id);

// Server-side truncation. We trust callers to have already validated input
// length, but a model-level cap is the load-bearing rule — never trust the
// caller to size a stored field correctly.
const clipTitle = (s: string): string =>
  s.length <= NOTIFICATION_TITLE_MAX_LENGTH
    ? s
    : s.slice(0, NOTIFICATION_TITLE_MAX_LENGTH - 1) + '…';

const clipBodyPreview = (s: string): string => {
  // Collapse to a single line first so a long body with newlines doesn't
  // produce an inbox row that overflows visually. We never store the raw
  // body — only this one-line preview.
  const oneLine = s.replace(/\s+/g, ' ').trim();
  if (oneLine.length === 0) return '';
  if (oneLine.length <= NOTIFICATION_BODY_PREVIEW_MAX_LENGTH) return oneLine;
  return oneLine.slice(0, NOTIFICATION_BODY_PREVIEW_MAX_LENGTH - 1) + '…';
};

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

const ensurePreferences = async (
  userId: string
): Promise<NotificationPreferenceDocument> => {
  // Upsert on first access so callers never have to special-case "no row
  // yet". The unique index on userId keeps this idempotent under races.
  const doc = await NotificationPreference.findOneAndUpdate(
    { userId: toObjectId(userId) },
    {
      $setOnInsert: {
        userId: toObjectId(userId),
        pushEnabled: DEFAULT_NOTIFICATION_PREFERENCES.pushEnabled,
        emailEnabled: DEFAULT_NOTIFICATION_PREFERENCES.emailEnabled,
        messagePreviewEnabled:
          DEFAULT_NOTIFICATION_PREFERENCES.messagePreviewEnabled,
        soundEnabled: DEFAULT_NOTIFICATION_PREFERENCES.soundEnabled,
        vibrationEnabled: DEFAULT_NOTIFICATION_PREFERENCES.vibrationEnabled,
        mutedConversationIds: []
      }
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return doc;
};

export const getPreferences = async (
  actor: AuthenticatedActor
): Promise<NotificationPreferencesDto> => {
  const doc = await ensurePreferences(actor.id);
  return toNotificationPreferencesDto(doc);
};

export const updatePreferences = async (
  actor: AuthenticatedActor,
  input: UpdateNotificationPreferencesInput
): Promise<NotificationPreferencesDto> => {
  const doc = await ensurePreferences(actor.id);

  if (input.pushEnabled !== undefined) doc.pushEnabled = input.pushEnabled;
  if (input.emailEnabled !== undefined) doc.emailEnabled = input.emailEnabled;
  if (input.messagePreviewEnabled !== undefined) {
    doc.messagePreviewEnabled = input.messagePreviewEnabled;
  }
  if (input.soundEnabled !== undefined) doc.soundEnabled = input.soundEnabled;
  if (input.vibrationEnabled !== undefined) {
    doc.vibrationEnabled = input.vibrationEnabled;
  }
  if (input.quietHours !== undefined) {
    // `null` clears the window; an object replaces it entirely. We don't
    // patch sub-fields because the timezone+start+end tuple has to stay
    // internally consistent.
    if (input.quietHours === null) {
      doc.quietHours = undefined;
    } else {
      doc.quietHours = {
        startMinute: input.quietHours.startMinute,
        endMinute: input.quietHours.endMinute,
        timezone: input.quietHours.timezone
      };
    }
  }
  if (input.mutedConversationIds !== undefined) {
    // Dedupe at write time so the document never accumulates duplicate ids
    // even if a client posts them.
    const unique = Array.from(new Set(input.mutedConversationIds));
    doc.mutedConversationIds = unique.map(toObjectId);
  }

  await doc.save();
  return toNotificationPreferencesDto(doc);
};

// ---------------------------------------------------------------------------
// Per-conversation preference (mute window / mention-only)
// ---------------------------------------------------------------------------

// Verify the caller is a current member of the conversation before allowing
// them to read or change a per-conversation preference. We reuse the
// resource-level helper to keep the rule in one place; on failure we map
// ForbiddenError → NotFoundError so a probing client cannot tell the
// difference between "conversation doesn't exist" and "you're not in it".
const assertConversationAccess = async (
  actor: AuthenticatedActor,
  conversationId: string
): Promise<void> => {
  const membership = await ConversationMember.findOne({
    conversationId: toObjectId(conversationId),
    userId: toObjectId(actor.id)
  });
  try {
    assertConversationMembership(membership, actor, conversationId);
  } catch (err) {
    if (err instanceof ForbiddenError) {
      throw new NotFoundError('Conversation not found');
    }
    throw err;
  }
};

export const getConversationNotificationPreference = async (
  actor: AuthenticatedActor,
  conversationId: string
): Promise<ConversationNotificationPreferenceDto> => {
  await assertConversationAccess(actor, conversationId);
  const doc = await ConversationNotificationPreference.findOne({
    userId: toObjectId(actor.id),
    conversationId: toObjectId(conversationId)
  });
  if (!doc) {
    return { conversationId, mentionOnly: false };
  }
  return toConversationNotificationPreferenceDto(doc);
};

export const updateConversationNotificationPreference = async (
  actor: AuthenticatedActor,
  conversationId: string,
  input: UpdateConversationNotificationPreferenceInput
): Promise<ConversationNotificationPreferenceDto> => {
  await assertConversationAccess(actor, conversationId);
  const set: Record<string, unknown> = {};
  const unset: Record<string, 1> = {};

  if (input.mutedUntil === null) {
    unset.mutedUntil = 1;
  } else if (typeof input.mutedUntil === 'string') {
    set.mutedUntil = new Date(input.mutedUntil);
  }
  if (input.mentionOnly !== undefined) {
    set.mentionOnly = input.mentionOnly;
  }

  const update: Record<string, Record<string, unknown>> = {
    $setOnInsert: {
      userId: toObjectId(actor.id),
      conversationId: toObjectId(conversationId)
    }
  };
  if (Object.keys(set).length > 0) update.$set = set;
  if (Object.keys(unset).length > 0) update.$unset = unset;

  const doc = await ConversationNotificationPreference.findOneAndUpdate(
    {
      userId: toObjectId(actor.id),
      conversationId: toObjectId(conversationId)
    },
    update,
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return toConversationNotificationPreferenceDto(doc);
};

// ---------------------------------------------------------------------------
// List, mark-read, unread count
// ---------------------------------------------------------------------------

const countUnread = (userId: string): Promise<number> =>
  Notification.countDocuments({
    userId: toObjectId(userId),
    readAt: { $exists: false }
  });

export const listNotifications = async (
  actor: AuthenticatedActor,
  query: ListNotificationsQuery
): Promise<ListNotificationsResult> => {
  const filter: FilterQuery<NotificationDocument> = {
    userId: toObjectId(actor.id)
  };
  if (query.unreadOnly) {
    filter.readAt = { $exists: false };
  }
  if (query.type) {
    filter.type = query.type;
  }
  if (query.cursor) {
    filter._id = { $lt: toObjectId(query.cursor) };
  }

  const docs = await Notification.find(filter)
    .sort({ _id: -1 })
    .limit(query.limit + 1);

  const hasMore = docs.length > query.limit;
  const page = hasMore ? docs.slice(0, query.limit) : docs;

  const items = page.map(toNotificationDto);
  const nextCursor =
    hasMore && page.length > 0
      ? (page[page.length - 1]._id as Types.ObjectId).toString()
      : null;
  const unreadCount = await countUnread(actor.id);
  return { items, nextCursor, unreadCount };
};

const fetchOwnedOr404 = async (
  actor: AuthenticatedActor,
  notificationId: string
): Promise<NotificationDocument> => {
  const doc = await Notification.findById(notificationId);
  // Resource-level guard. assertCanAccessNotification throws Forbidden when
  // the userId doesn't match the actor; we translate that to 404 so a
  // probing client can't distinguish "exists but not yours" from "missing".
  if (!doc) throw new NotFoundError('Notification not found');
  try {
    assertCanAccessNotification(
      { id: (doc._id as Types.ObjectId).toString(), userId: doc.userId.toString() },
      actor
    );
  } catch {
    throw new NotFoundError('Notification not found');
  }
  return doc;
};

export const markRead = async (
  actor: AuthenticatedActor,
  notificationId: string
): Promise<NotificationDto> => {
  const doc = await fetchOwnedOr404(actor, notificationId);
  // Idempotent: re-marking an already-read row keeps the original timestamp
  // so the audit trail of when the user first acknowledged is preserved.
  if (!doc.readAt) {
    doc.readAt = new Date();
    await doc.save();
  }
  return toNotificationDto(doc);
};

export const markUnread = async (
  actor: AuthenticatedActor,
  notificationId: string
): Promise<NotificationDto> => {
  const doc = await fetchOwnedOr404(actor, notificationId);
  if (doc.readAt) {
    doc.readAt = undefined;
    await doc.save();
  }
  return toNotificationDto(doc);
};

export const markAllRead = async (
  actor: AuthenticatedActor
): Promise<{ updated: number }> => {
  const now = new Date();
  const res = await Notification.updateMany(
    {
      userId: toObjectId(actor.id),
      readAt: { $exists: false }
    },
    { $set: { readAt: now } }
  );
  return { updated: res.modifiedCount };
};

// ---------------------------------------------------------------------------
// Create (called by other modules — not exposed as an HTTP endpoint)
// ---------------------------------------------------------------------------

const getEffectivePreferencesForUser = async (
  userId: string
): Promise<NotificationPreferencesDto> => {
  const doc = await ensurePreferences(userId);
  return toNotificationPreferencesDto(doc);
};

interface CreateAndPushOptions {
  // Skip the push fan-out entirely. Used when the caller knows the
  // recipient won't want a push (e.g. notifications about themselves, or
  // when the producing event is non-urgent).
  skipPush?: boolean;
  // The recipient was explicitly mentioned. Used by the mention-only
  // conversation preference: an unmentioned message in a mention-only
  // conversation suppresses push (inbox still writes). Defaults to false.
  isMention?: boolean;
}

// Compute whether the given moment falls inside the recipient's quiet-hours
// window. The window is half-open `[start, end)` in the user's local clock.
// A reversed window (`endMinute < startMinute`) wraps midnight — e.g.
// `start=22:00, end=07:00` matches 22:00-23:59 and 00:00-06:59.
const isInQuietHours = (qh: QuietHoursDto, at: Date): boolean => {
  let minutes: number;
  try {
    // Intl.DateTimeFormat handles arbitrary IANA zones without us shipping a
    // tz database. An unknown zone throws RangeError on format(); we catch
    // that and treat it as "quiet hours not enforceable" — safer than
    // accidentally muting because of a typo.
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: qh.timezone,
      hour: 'numeric',
      hour12: false,
      minute: 'numeric'
    });
    const parts = formatter.formatToParts(at);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    minutes = (hour % 24) * 60 + minute;
  } catch {
    return false;
  }
  if (
    Number.isNaN(minutes) ||
    minutes < 0 ||
    minutes >= QUIET_HOURS_MINUTES_PER_DAY
  ) {
    return false;
  }
  if (qh.startMinute < qh.endMinute) {
    return minutes >= qh.startMinute && minutes < qh.endMinute;
  }
  // Wrapped window — e.g. 22:00-07:00.
  return minutes >= qh.startMinute || minutes < qh.endMinute;
};

// Write a notification for one user. Other modules import this — callers
// must ensure they only write notifications for users with a legitimate
// authorization to know about the event (e.g. conversation members for a
// new message). Recipients are validated up front rather than per-row so
// upstream services keep the authorization rule co-located with the action
// that triggered the notification.
export const createNotification = async (
  input: CreateNotificationInput,
  options: CreateAndPushOptions = {}
): Promise<NotificationDto> => {
  // Defensive caps. Callers should pass already-clipped strings, but the
  // service-level clip stops a buggy caller from blowing past the schema
  // maxlength and triggering a write rejection at runtime.
  const title = clipTitle(input.title);
  const bodyPreview =
    input.bodyPreview !== undefined ? clipBodyPreview(input.bodyPreview) : undefined;

  const doc = await Notification.create({
    userId: toObjectId(input.userId),
    type: input.type,
    title,
    ...(bodyPreview && bodyPreview.length > 0 ? { bodyPreview } : {}),
    ...(input.entityType ? { entityType: input.entityType } : {}),
    ...(input.entityId ? { entityId: toObjectId(input.entityId) } : {}),
    ...(input.conversationId
      ? { conversationId: toObjectId(input.conversationId) }
      : {}),
    ...(input.data ? { data: input.data } : {})
  });

  if (!options.skipPush) {
    // Honor the user's preferences before fanning out. Inbox row is always
    // written so the user can scroll back; only the push payload is gated.
    const prefs = await getEffectivePreferencesForUser(input.userId);
    const globallyMuted =
      !!input.conversationId &&
      prefs.mutedConversationIds.includes(input.conversationId);

    // Per-conversation override. The row only exists when the user has
    // explicitly configured the conversation — we treat its absence as "no
    // override" (defaults already covered by the inbox-level flags).
    let perConvMuted = false;
    let perConvMentionOnly = false;
    if (input.conversationId) {
      const conv = await ConversationNotificationPreference.findOne({
        userId: toObjectId(input.userId),
        conversationId: toObjectId(input.conversationId)
      });
      if (conv) {
        if (conv.mutedUntil && conv.mutedUntil.getTime() > Date.now()) {
          perConvMuted = true;
        }
        perConvMentionOnly = conv.mentionOnly;
      }
    }

    const inQuietHours = prefs.quietHours
      ? isInQuietHours(prefs.quietHours, new Date())
      : false;

    // Sensitive content categories never carry a preview in push payloads,
    // regardless of the user's messagePreviewEnabled flag. Report status
    // changes and moderation actions could leak the existence/details of a
    // moderation case to anyone glancing at the lock screen.
    const isSensitiveType =
      input.type === NOTIFICATION_TYPE.REPORT_STATUS_CHANGED ||
      input.type === NOTIFICATION_TYPE.MODERATION_ACTION;

    const mentionGate =
      perConvMentionOnly && !options.isMention && !isSensitiveType;

    const shouldPush =
      prefs.pushEnabled &&
      !globallyMuted &&
      !perConvMuted &&
      !inQuietHours &&
      !mentionGate;

    if (shouldPush) {
      const includePreview =
        prefs.messagePreviewEnabled &&
        !isSensitiveType &&
        bodyPreview !== undefined &&
        bodyPreview.length > 0;
      enqueuePushNotification({
        userId: input.userId,
        notificationId: (doc._id as Types.ObjectId).toString(),
        type: input.type,
        title,
        // Strip the preview when the user has opted out of message
        // previews. The recipient still gets "New message", just without
        // the body.
        ...(includePreview ? { bodyPreview } : {}),
        ...(input.conversationId
          ? { conversationId: input.conversationId }
          : {})
      });
    }
  }

  return toNotificationDto(doc);
};

