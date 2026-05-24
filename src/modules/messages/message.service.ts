import mongoose, { type FilterQuery, type Types } from 'mongoose';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError
} from '../../utils/errors';
import { auditMessageExpiredNow } from '../../utils/audit';
import { emitRealtime } from '../../services/realtimeEvents';
import {
  Conversation,
  type ConversationDocument
} from '../conversations/conversation.model';
import { ConversationMember } from '../conversations/conversationMember.model';
import {
  CONVERSATION_MEMBER_ROLE,
  CONVERSATION_TYPE
} from '../conversations/conversation.types';
import type { ConversationMemberDocument } from '../conversations/conversationMember.model';
import {
  assertConversationMembership,
  type AuthenticatedActor
} from '../permissions/authorization';
import { PERMISSIONS } from '../permissions/permissions.constants';
import { Attachment } from '../media/attachment.model';
import { attachToMessage } from '../media/media.service';
import { ATTACHMENT_STATUS } from '../media/media.types';
import { User } from '../users/user.model';
import { isBlockedBetween } from '../moderation/block.service';
import { createNotification } from '../notifications/notification.service';
import {
  NOTIFICATION_ENTITY_TYPE,
  NOTIFICATION_TYPE
} from '../notifications/notification.types';
import { Message, toMessageDto, type MessageDocument } from './message.model';
import {
  MessageReceipt,
  toMessageReceiptDto
} from './messageReceipt.model';
import {
  MessageReaction,
  toMessageReactionDto,
  type MessageReactionDocument
} from './messageReaction.model';
import {
  MESSAGE_DELETION_REASON,
  MESSAGE_EXPIRATION_POLICY,
  MESSAGE_PREVIEW_MAX_LENGTH,
  type ListMessagesResult,
  type MessageAttachmentSummary,
  type MessageDto,
  type MessageReactionDto,
  type MessageReceiptDto
} from './message.types';
import type {
  AddReactionInput,
  EditMessageInput,
  ListMessagesQuery,
  SendMessageInput
} from './message.validation';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const toObjectId = (id: string): Types.ObjectId => new mongoose.Types.ObjectId(id);

const actorIsModerator = (actor: AuthenticatedActor): boolean =>
  actor.permissions.includes(PERMISSIONS.MESSAGE_MODERATE);

const findActiveMembership = (
  conversationId: string,
  userId: string
): Promise<ConversationMemberDocument | null> =>
  ConversationMember.findOne({
    conversationId: toObjectId(conversationId),
    userId: toObjectId(userId),
    leftAt: { $exists: false }
  });

// Strict membership check used by write paths. Returns the membership when
// present, otherwise hides the conversation behind a 404 so a non-member
// cannot probe for its existence. Distinct from `assertConversationMembership`
// in authorization.ts, which intentionally bypasses for platform moderators —
// moderators have no business sending messages or reactions to conversations
// they don't belong to.
const requireWritingMembership = async (
  conversationId: string,
  actor: AuthenticatedActor
): Promise<ConversationMemberDocument> => {
  const membership = await findActiveMembership(conversationId, actor.id);
  if (!membership) throw new NotFoundError('Conversation not found');
  return membership;
};

const fetchConversationOr404 = async (
  conversationId: string
): Promise<ConversationDocument> => {
  const conv = await Conversation.findById(conversationId);
  if (!conv) throw new NotFoundError('Conversation not found');
  return conv;
};

const fetchMessageOr404 = async (
  messageId: string
): Promise<MessageDocument> => {
  const msg = await Message.findById(messageId);
  if (!msg) throw new NotFoundError('Message not found');
  return msg;
};

const isConversationAdmin = (
  membership: ConversationMemberDocument
): boolean =>
  membership.role === CONVERSATION_MEMBER_ROLE.ADMIN ||
  membership.role === CONVERSATION_MEMBER_ROLE.OWNER;

const buildPreview = (text: string): string => {
  // Single-line preview, truncated. We never store the raw multi-line body on
  // the conversation — the full message lives only on its own document.
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= MESSAGE_PREVIEW_MAX_LENGTH) return oneLine;
  return oneLine.slice(0, MESSAGE_PREVIEW_MAX_LENGTH - 1).trimEnd() + '…';
};

const updateConversationLastMessage = async (
  conversation: ConversationDocument,
  message: MessageDocument
): Promise<void> => {
  // Only advance the preview if this message is newer than the current one.
  // Older inserts (from a rare reorder / retry) must not overwrite the head.
  const current = conversation.lastMessage;
  if (current && current.sentAt > message.createdAt) return;

  // For attachment-only messages the text is empty; fall back to a generic
  // attachment marker so the inbox preview isn't blank. The Mongoose schema
  // requires a non-empty preview string — never let it be ''.
  let preview = buildPreview(message.text);
  if (preview.length === 0) {
    const count = message.attachments?.length ?? 0;
    preview =
      count > 1 ? `[${count} attachments]` : count === 1 ? '[attachment]' : '…';
  }

  conversation.lastMessage = {
    messageId: message._id as Types.ObjectId,
    senderId: message.senderId,
    preview,
    sentAt: message.createdAt
  };
  await conversation.save();
};

// Batch-load attachments for a set of message documents and return a map of
// messageId -> attachment summary list. Used to enrich DTOs without forcing
// callers to N+1 the media collection. Only attachments still in the
// `attached` state are surfaced — anything deleted, rejected, or otherwise
// in an unexpected state is dropped so a leaked id can't surface stale
// metadata.
const loadAttachmentSummariesForMessages = async (
  messages: MessageDocument[]
): Promise<Map<string, MessageAttachmentSummary[]>> => {
  const result = new Map<string, MessageAttachmentSummary[]>();
  const allIds = messages.flatMap((m) =>
    (m.attachments ?? []).map((id) => (id as Types.ObjectId).toString())
  );
  if (allIds.length === 0) return result;

  const uniqueIds = Array.from(new Set(allIds)).map(
    (id) => new mongoose.Types.ObjectId(id)
  );
  const attachments = await Attachment.find({
    _id: { $in: uniqueIds },
    status: ATTACHMENT_STATUS.ATTACHED
  });
  const byId = new Map(
    attachments.map((a) => [(a._id as Types.ObjectId).toString(), a])
  );

  for (const msg of messages) {
    const msgId = (msg._id as Types.ObjectId).toString();
    const summaries: MessageAttachmentSummary[] = [];
    for (const ref of msg.attachments ?? []) {
      const a = byId.get(ref.toString());
      if (!a) continue;
      const summary: MessageAttachmentSummary = {
        id: (a._id as Types.ObjectId).toString(),
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        originalFilename: a.originalFilename
      };
      if (a.width != null) summary.width = a.width;
      if (a.height != null) summary.height = a.height;
      if (a.durationSeconds != null) summary.durationSeconds = a.durationSeconds;
      summaries.push(summary);
    }
    if (summaries.length > 0) result.set(msgId, summaries);
  }
  return result;
};

const buildMessageDto = async (msg: MessageDocument): Promise<MessageDto> => {
  const map = await loadAttachmentSummariesForMessages([msg]);
  const summaries = map.get((msg._id as Types.ObjectId).toString());
  return toMessageDto(msg, summaries);
};

const findDirectCounterpartyId = async (
  conversation: ConversationDocument,
  actorId: string
): Promise<string | null> => {
  if (conversation.type !== CONVERSATION_TYPE.DIRECT) return null;
  const other = await ConversationMember.findOne({
    conversationId: conversation._id,
    userId: { $ne: toObjectId(actorId) }
  });
  return other ? other.userId.toString() : null;
};

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

export const sendMessage = async (
  actor: AuthenticatedActor,
  conversationId: string,
  input: SendMessageInput
): Promise<MessageDto> => {
  const conv = await fetchConversationOr404(conversationId);
  const membership = await requireWritingMembership(conversationId, actor);

  // Conversation-level "only admins may post". Plain members hit this even
  // though they could otherwise send; platform moderators are not exempt —
  // they have no business posting as a non-admin in a group they joined.
  if (
    conv.settings.whoCanSendMessages === 'admins' &&
    !isConversationAdmin(membership)
  ) {
    throw new ForbiddenError('Only conversation admins can post here');
  }

  // Direct-conversation block rule. The error wording deliberately doesn't
  // reveal which side initiated the block.
  const counterpartyId = await findDirectCounterpartyId(conv, actor.id);
  if (counterpartyId && (await isBlockedBetween(actor.id, counterpartyId))) {
    throw new ForbiddenError('Cannot send messages to this conversation');
  }

  if (input.replyToMessageId) {
    const parent = await Message.findById(input.replyToMessageId);
    if (!parent) {
      throw new BadRequestError('Reply target does not exist');
    }
    if (parent.conversationId.toString() !== conversationId) {
      // Cross-conversation replies would leak existence of other messages.
      throw new BadRequestError(
        'Reply target must be in the same conversation'
      );
    }
  }

  // Disappearing-message stamp at send time. Reading the value off the
  // conversation we already fetched avoids a second round-trip and means the
  // expiration tracks the setting the sender last saw — flipping the setting
  // mid-conversation doesn't retroactively change old messages.
  const dm = conv.settings.disappearingMessages;
  const expirationFields =
    dm.duration !== 'off' && dm.durationSeconds > 0
      ? {
          expiresAt: new Date(Date.now() + dm.durationSeconds * 1000),
          expirationPolicy: MESSAGE_EXPIRATION_POLICY.SEND_TIME
        }
      : {};

  const msg = await Message.create({
    conversationId: conv._id,
    senderId: toObjectId(actor.id),
    text: input.text ?? '',
    attachments: [],
    ...(input.replyToMessageId
      ? { replyToMessageId: toObjectId(input.replyToMessageId) }
      : {}),
    ...expirationFields
  });

  // Bind attachments after the message exists so they reference a real id.
  // If the bind fails (ownership / status / cross-conversation), roll back
  // the message — better than leaving a body with phantom attachment refs.
  let attachmentSummaries: MessageAttachmentSummary[] | undefined;
  if (input.attachmentIds && input.attachmentIds.length > 0) {
    try {
      const attached = await attachToMessage({
        actor,
        conversationId: conv._id.toString(),
        messageId: (msg._id as Types.ObjectId).toString(),
        attachmentIds: input.attachmentIds
      });
      msg.attachments = attached.map((a) => a._id as Types.ObjectId);
      await msg.save();
      attachmentSummaries = attached.map((a) => {
        const summary: MessageAttachmentSummary = {
          id: (a._id as Types.ObjectId).toString(),
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          originalFilename: a.originalFilename
        };
        if (a.width != null) summary.width = a.width;
        if (a.height != null) summary.height = a.height;
        if (a.durationSeconds != null) {
          summary.durationSeconds = a.durationSeconds;
        }
        return summary;
      });
    } catch (err) {
      // Roll back the message — it never made it into the conversation
      // preview yet, so we don't have to undo lastMessage either.
      await Message.deleteOne({ _id: msg._id });
      throw err;
    }
  }

  await updateConversationLastMessage(conv, msg);

  const dto = toMessageDto(msg, attachmentSummaries);
  emitRealtime('message.created', {
    conversationId: dto.conversationId,
    message: dto
  });

  // Notify other active members. Best-effort: a notification failure must
  // not roll the message back — the inbox row is convenience metadata; the
  // canonical event is the message itself.
  await fanOutMessageNotifications(actor, conv, msg, dto.text ?? '').catch(() => {
    /* swallowed; logged inside the helper */
  });

  return dto;
};

// Build inbox + push notifications for every other member of the
// conversation. Membership is the authorization gate — only members of a
// conversation can be members for notification purposes, so a leaked
// conversationId in the input never produces notifications for a non-member.
const fanOutMessageNotifications = async (
  actor: AuthenticatedActor,
  conv: ConversationDocument,
  msg: MessageDocument,
  text: string
): Promise<void> => {
  // Active recipients = members who have not left, excluding the sender.
  const recipients = await ConversationMember.find({
    conversationId: conv._id,
    userId: { $ne: toObjectId(actor.id) },
    leftAt: { $exists: false }
  }).select('userId mutedUntil');
  if (recipients.length === 0) return;

  // Build a displayable title up front. We never fall back to "Someone"
  // silently — if the sender's user document is gone, skip the fan-out so
  // we don't write a row that pretends to know the sender.
  const sender = await User.findById(actor.id).select('displayName');
  if (!sender) return;
  const senderName = sender.displayName;

  const conversationTitle =
    conv.type === 'group' && conv.title ? conv.title : null;

  const messageId = (msg._id as Types.ObjectId).toString();
  const conversationId = conv._id.toString();

  const now = new Date();

  // Fan out per-recipient. Each recipient's ConversationMember.mutedUntil
  // controls whether the push payload is suppressed — the inbox row is
  // always written so the user can scroll back. The notification service
  // additionally honors NotificationPreference.mutedConversationIds inside
  // createNotification, so a recipient can mute push for a conversation
  // independently of the inbox-mute setting.
  for (const m of recipients) {
    const isMutedByMember = !!m.mutedUntil && m.mutedUntil > now;
    await createNotification(
      {
        userId: m.userId.toString(),
        type: NOTIFICATION_TYPE.MESSAGE_RECEIVED,
        title: conversationTitle
          ? `${senderName} in ${conversationTitle}`
          : senderName,
        // Body preview is the message text. The notification model clips
        // it; attachment-only messages produce an empty preview which the
        // model drops, so the inbox row is built around the title.
        bodyPreview: text.length > 0 ? text : undefined,
        entityType: NOTIFICATION_ENTITY_TYPE.MESSAGE,
        entityId: messageId,
        conversationId,
        data: { senderId: actor.id }
      },
      { skipPush: isMutedByMember }
    );
  }
};

// Notify the author of a message when someone reacts to it. Skipped when
// the reactor is the author themselves (self-reactions are uncommon but
// possible; either way, you don't need to be told about your own reaction).
const notifyMessageAuthorOfReaction = async (
  actor: AuthenticatedActor,
  msg: MessageDocument,
  emoji: string
): Promise<void> => {
  const authorId = msg.senderId.toString();
  if (authorId === actor.id) return;
  const reactor = await User.findById(actor.id).select('displayName');
  if (!reactor) return;
  await createNotification({
    userId: authorId,
    type: NOTIFICATION_TYPE.MESSAGE_REACTION,
    title: `${reactor.displayName} reacted ${emoji}`,
    entityType: NOTIFICATION_ENTITY_TYPE.MESSAGE,
    entityId: (msg._id as Types.ObjectId).toString(),
    conversationId: msg.conversationId.toString(),
    data: { reactorId: actor.id, emoji }
  });
};

// ---------------------------------------------------------------------------
// List & get
// ---------------------------------------------------------------------------

export const listMessages = async (
  actor: AuthenticatedActor,
  conversationId: string,
  query: ListMessagesQuery
): Promise<ListMessagesResult> => {
  // Read path: members see their conversations; platform moderators may also
  // read for investigation (mirror of conversation.getConversation).
  const membership = await findActiveMembership(conversationId, actor.id);
  assertConversationMembership(membership, actor, conversationId);

  const filter: FilterQuery<MessageDocument> = {
    conversationId: toObjectId(conversationId)
  };
  if (query.cursor) {
    filter._id = { $lt: toObjectId(query.cursor) };
  }

  const docs = await Message.find(filter)
    .sort({ _id: -1 })
    .limit(query.limit + 1);

  const hasMore = docs.length > query.limit;
  const page = hasMore ? docs.slice(0, query.limit) : docs;

  const attachmentsByMessage = await loadAttachmentSummariesForMessages(page);
  const items = page.map((doc) =>
    toMessageDto(
      doc,
      attachmentsByMessage.get((doc._id as Types.ObjectId).toString())
    )
  );
  const nextCursor =
    hasMore && page.length > 0
      ? (page[page.length - 1]._id as Types.ObjectId).toString()
      : null;
  return { items, nextCursor };
};

export const getMessage = async (
  actor: AuthenticatedActor,
  messageId: string
): Promise<MessageDto> => {
  const msg = await fetchMessageOr404(messageId);
  const conversationId = msg.conversationId.toString();
  const membership = await findActiveMembership(conversationId, actor.id);
  assertConversationMembership(membership, actor, conversationId);
  return buildMessageDto(msg);
};

// ---------------------------------------------------------------------------
// Edit & delete
// ---------------------------------------------------------------------------

export const editMessage = async (
  actor: AuthenticatedActor,
  messageId: string,
  input: EditMessageInput
): Promise<MessageDto> => {
  const msg = await fetchMessageOr404(messageId);

  // Deleted messages cannot be revived through edit.
  if (msg.deletedAt) throw new NotFoundError('Message not found');

  const isSender = msg.senderId.toString() === actor.id;
  const isMod = actorIsModerator(actor);
  if (!isSender && !isMod) {
    throw new ForbiddenError('You cannot edit this message');
  }
  if (isSender && !actor.permissions.includes(PERMISSIONS.MESSAGE_EDIT_OWN)) {
    throw new ForbiddenError('You cannot edit this message');
  }

  // Sender (or mod) must still have access to the conversation. A user who
  // was removed from the group cannot keep editing their old posts.
  const conversationId = msg.conversationId.toString();
  const membership = await findActiveMembership(conversationId, actor.id);
  if (!isMod) {
    if (!membership) throw new NotFoundError('Message not found');
  }

  msg.text = input.text;
  msg.editedAt = new Date();
  await msg.save();

  const dto = await buildMessageDto(msg);
  emitRealtime('message.updated', {
    conversationId: dto.conversationId,
    message: dto
  });
  return dto;
};

export const deleteMessage = async (
  actor: AuthenticatedActor,
  messageId: string
): Promise<MessageDto> => {
  const msg = await fetchMessageOr404(messageId);
  if (msg.deletedAt) {
    // Idempotent: return the masked DTO without re-emitting events.
    return toMessageDto(msg);
  }

  const isSender = msg.senderId.toString() === actor.id;
  const isMod = actorIsModerator(actor);

  if (isSender) {
    if (!actor.permissions.includes(PERMISSIONS.MESSAGE_DELETE_OWN)) {
      throw new ForbiddenError('You cannot delete this message');
    }
  } else if (!isMod) {
    throw new ForbiddenError('You cannot delete this message');
  }

  msg.deletedAt = new Date();
  msg.deletedBy = toObjectId(actor.id);
  msg.deletionReason = isMod && !isSender
    ? MESSAGE_DELETION_REASON.MODERATOR_DELETED
    : MESSAGE_DELETION_REASON.USER_DELETED;
  await msg.save();

  // Deleted message: drop attachments from the DTO (toMessageDto already
  // masks them when the parent is redacted). The attachment documents remain
  // in the DB for moderation/audit until a separate sweep cleans them up.
  const dto = toMessageDto(msg);
  emitRealtime('message.deleted', {
    conversationId: dto.conversationId,
    message: dto
  });
  return dto;
};

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

export const addReaction = async (
  actor: AuthenticatedActor,
  messageId: string,
  input: AddReactionInput
): Promise<MessageReactionDto> => {
  const msg = await fetchMessageOr404(messageId);
  if (msg.deletedAt) throw new NotFoundError('Message not found');

  const conversationId = msg.conversationId.toString();
  await requireWritingMembership(conversationId, actor);

  if (!actor.permissions.includes(PERMISSIONS.MESSAGE_CREATE)) {
    throw new ForbiddenError('You cannot react to messages');
  }

  try {
    const reaction = await MessageReaction.create({
      messageId: msg._id,
      conversationId: msg.conversationId,
      userId: toObjectId(actor.id),
      emoji: input.emoji
    });
    const dto = toMessageReactionDto(reaction);
    emitRealtime('message.reaction_added', {
      conversationId,
      messageId: dto.messageId,
      reaction: dto
    });
    // Best-effort: a notification failure must not undo the reaction.
    await notifyMessageAuthorOfReaction(actor, msg, dto.emoji).catch(() => {
      /* swallowed; the reaction itself succeeded */
    });
    return dto;
  } catch (err) {
    if (
      err instanceof mongoose.mongo.MongoServerError &&
      err.code === 11000
    ) {
      // Same user re-sending the same emoji: surface the existing reaction
      // rather than 409. Clients can treat both as success.
      const existing = await MessageReaction.findOne({
        messageId: msg._id,
        userId: toObjectId(actor.id),
        emoji: input.emoji
      });
      if (existing) return toMessageReactionDto(existing);
      throw new ConflictError('Reaction could not be saved');
    }
    throw err;
  }
};

export const removeReaction = async (
  actor: AuthenticatedActor,
  messageId: string,
  reactionId: string
): Promise<void> => {
  const reaction: MessageReactionDocument | null =
    await MessageReaction.findById(reactionId);
  if (!reaction) throw new NotFoundError('Reaction not found');
  if (reaction.messageId.toString() !== messageId) {
    // Route param mismatch — don't leak that the reaction exists elsewhere.
    throw new NotFoundError('Reaction not found');
  }

  const conversationId = reaction.conversationId.toString();
  const isOwner = reaction.userId.toString() === actor.id;
  const isMod = actorIsModerator(actor);

  if (!isOwner && !isMod) {
    throw new ForbiddenError('You cannot remove this reaction');
  }
  // Non-moderator removals must still be from an active member. A mod can
  // clean up after a removed user.
  if (!isMod) {
    await requireWritingMembership(conversationId, actor);
  }

  await MessageReaction.deleteOne({ _id: reaction._id });

  emitRealtime('message.reaction_removed', {
    conversationId,
    messageId: reaction.messageId.toString(),
    reactionId: (reaction._id as Types.ObjectId).toString(),
    userId: reaction.userId.toString()
  });
};

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

type ReceiptKind = 'delivered' | 'read';

const upsertReceipt = async (
  actor: AuthenticatedActor,
  messageId: string,
  kind: ReceiptKind
): Promise<MessageReceiptDto> => {
  const msg = await fetchMessageOr404(messageId);

  // You cannot ack your own message. Lets us treat "all participants have a
  // receipt" as a clean signal for unread counts in later prompts.
  if (msg.senderId.toString() === actor.id) {
    throw new BadRequestError('Cannot mark your own message');
  }

  const conversationId = msg.conversationId.toString();
  // Membership is required for receipts, including for moderators — a
  // receipt is an active-presence signal, not a moderation action.
  const membership = await findActiveMembership(conversationId, actor.id);
  if (!membership) throw new NotFoundError('Message not found');

  const now = new Date();

  // deliveredAt stays the *first* confirmed-receipt time, so we only set it
  // on insert. readAt is always bumped to the most recent read. For a "read"
  // event that arrives without a prior "delivered", $setOnInsert seeds
  // deliveredAt = now so the timeline stays consistent.
  //
  // $set and $setOnInsert MUST NOT target the same field path — MongoDB
  // rejects the operation with a conflict otherwise.
  const update: Record<string, Record<string, unknown>> = {
    $setOnInsert: {
      messageId: msg._id,
      conversationId: msg.conversationId,
      userId: toObjectId(actor.id),
      deliveredAt: now
    }
  };
  if (kind === 'read') {
    update.$set = { readAt: now };
  }

  const receipt = await MessageReceipt.findOneAndUpdate(
    {
      messageId: msg._id,
      userId: toObjectId(actor.id)
    },
    update,
    { new: true, upsert: true }
  );

  const dto = toMessageReceiptDto(receipt);
  emitRealtime(kind === 'read' ? 'message.read' : 'message.delivered', {
    conversationId,
    messageId: dto.messageId,
    receipt: dto
  });
  return dto;
};

export const markDelivered = (
  actor: AuthenticatedActor,
  messageId: string
): Promise<MessageReceiptDto> => upsertReceipt(actor, messageId, 'delivered');

export const markRead = (
  actor: AuthenticatedActor,
  messageId: string
): Promise<MessageReceiptDto> => upsertReceipt(actor, messageId, 'read');

// ---------------------------------------------------------------------------
// Force-expire a single message (owner or platform moderator)
// ---------------------------------------------------------------------------

export const expireMessageNow = async (
  actor: AuthenticatedActor,
  messageId: string
): Promise<MessageDto> => {
  const msg = await fetchMessageOr404(messageId);

  if (msg.deletedAt) {
    // Already redacted — emit nothing, but return the masked DTO so the
    // client gets a consistent shape.
    return toMessageDto(msg);
  }
  if (msg.expiredAt) {
    return toMessageDto(msg);
  }

  const isSender = msg.senderId.toString() === actor.id;
  const isMod = actorIsModerator(actor);

  if (isSender) {
    // Reuse the standard self-delete permission — there is no separate
    // "expire-own" permission and a sender who can delete can clearly choose
    // to expire it instead.
    if (!actor.permissions.includes(PERMISSIONS.MESSAGE_DELETE_OWN)) {
      throw new ForbiddenError('You cannot expire this message');
    }
  } else if (!isMod) {
    throw new ForbiddenError('You cannot expire this message');
  }

  // Non-moderator callers must still be active members of the conversation.
  const conversationId = msg.conversationId.toString();
  if (!isMod) {
    const membership = await findActiveMembership(conversationId, actor.id);
    if (!membership) throw new NotFoundError('Message not found');
  }

  const now = new Date();
  msg.text = '';
  msg.expiredAt = now;
  // Stamp expiresAt so the cleanup job's filter "expiresAt set, expiredAt
  // missing" doesn't pick this up — and so the DTO carries a deterministic
  // expiry timestamp for clients.
  if (!msg.expiresAt) msg.expiresAt = now;
  msg.deletedAt = now;
  msg.deletedBy = toObjectId(actor.id);
  msg.deletionReason = MESSAGE_DELETION_REASON.EXPIRED;
  await msg.save();

  auditMessageExpiredNow(
    { actorId: actor.id },
    {
      conversationId,
      messageId: (msg._id as Types.ObjectId).toString(),
      reason: isMod && !isSender ? 'moderator' : 'owner'
    }
  );

  const dto = toMessageDto(msg);
  emitRealtime('message.expired', {
    conversationId,
    messageId: dto.id,
    message: dto
  });
  return dto;
};
