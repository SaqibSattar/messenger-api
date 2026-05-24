import mongoose, { type FilterQuery, type Types } from 'mongoose';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError
} from '../../utils/errors';
import { auditModerationAction } from '../../utils/audit';
import type { AuditContext } from '../../utils/audit';
import type { AuthenticatedActor } from '../permissions/authorization';
import { PERMISSIONS, ROLES } from '../permissions/permissions.constants';
import { User } from '../users/user.model';
import { USER_STATUS } from '../users/user.types';
import {
  Session,
  SESSION_REVOKED_REASON
} from '../sessions/session.model';
import { Conversation } from '../conversations/conversation.model';
import { Message } from '../messages/message.model';
import { createNotification } from '../notifications/notification.service';
import {
  NOTIFICATION_ENTITY_TYPE,
  NOTIFICATION_TYPE
} from '../notifications/notification.types';
import {
  ModerationAction,
  toModerationActionDto,
  type ModerationActionDocument
} from './moderationAction.model';
import { Report } from './report.model';
import {
  ALLOWED_ACTION_TARGETS,
  MODERATION_ACTION_TYPE,
  MODERATION_TARGET_TYPE,
  type ModerationActionDto
} from './moderation.types';
import type {
  CreateModerationActionInput,
  ListModerationActionsQuery
} from './moderation.validation';

const toObjectId = (id: string): Types.ObjectId => new mongoose.Types.ObjectId(id);

const revokeAllUserSessions = async (userId: string): Promise<void> => {
  await Session.updateMany(
    {
      userId: toObjectId(userId),
      revokedAt: { $exists: false }
    },
    {
      $set: {
        revokedAt: new Date(),
        revokedReason: SESSION_REVOKED_REASON.LOGOUT_ALL
      }
    }
  );
};

// Verify that the target the moderator is acting against exists, and apply
// the side effect that matches the action. Side effects are intentionally
// minimal: this is an auditable record of what happened, plus the smallest
// state change to make it real. Anything richer (notifications, schedules)
// can layer on top without changing the action contract.
const applyActionSideEffect = async (
  actor: AuthenticatedActor,
  input: CreateModerationActionInput
): Promise<void> => {
  switch (input.actionType) {
    case MODERATION_ACTION_TYPE.WARN_USER: {
      const user = await User.findById(input.targetId).select('_id');
      if (!user) throw new NotFoundError('Target user not found');
      // No state change — the audited record is itself the warning.
      return;
    }
    case MODERATION_ACTION_TYPE.SUSPEND_USER: {
      const user = await User.findById(input.targetId);
      if (!user) throw new NotFoundError('Target user not found');
      // Prevent a moderator from suspending an account that outranks them.
      if (user.role === ROLES.SUPER_ADMIN) {
        throw new ForbiddenError(
          'Cannot suspend a super-admin via moderation'
        );
      }
      if (user._id.toString() === actor.id) {
        throw new BadRequestError('Cannot apply moderation actions to yourself');
      }
      if (user.status !== USER_STATUS.SUSPENDED) {
        user.status = USER_STATUS.SUSPENDED;
        await user.save();
        await revokeAllUserSessions(user._id.toString());
      }
      return;
    }
    case MODERATION_ACTION_TYPE.RESTORE_USER: {
      const user = await User.findById(input.targetId);
      if (!user) throw new NotFoundError('Target user not found');
      if (user.status === USER_STATUS.SUSPENDED) {
        user.status = USER_STATUS.ACTIVE;
        await user.save();
      }
      return;
    }
    case MODERATION_ACTION_TYPE.DELETE_MESSAGE:
    case MODERATION_ACTION_TYPE.HIDE_MESSAGE: {
      const msg = await Message.findById(input.targetId);
      if (!msg) throw new NotFoundError('Target message not found');
      // Soft-delete via the same redaction the user-facing delete uses —
      // keep the row for audit and let the standard DTO mask the body.
      if (!msg.deletedAt) {
        msg.deletedAt = new Date();
        msg.deletedBy = toObjectId(actor.id);
        msg.text = '';
        await msg.save();
      }
      return;
    }
    case MODERATION_ACTION_TYPE.REMOVE_STORY: {
      // Story-removal goes through the dedicated story moderation flow in
      // prompt 07b. Here we only check existence so the action audit row is
      // not orphaned. Tighter coupling would create a circular import.
      const exists = await mongoose.models.Story?.exists?.({
        _id: toObjectId(input.targetId)
      });
      if (exists === null || exists === undefined) {
        // Story collection not loaded in this test surface — treat as missing
        // so we never silently audit against an id we can't verify.
        throw new NotFoundError('Target story not found');
      }
      return;
    }
    case MODERATION_ACTION_TYPE.REMOVE_FROM_CONVERSATION: {
      const meta = input.metadata as { conversationId?: unknown } | undefined;
      const conversationId =
        typeof meta?.conversationId === 'string' ? meta.conversationId : null;
      if (!conversationId || !/^[a-fA-F0-9]{24}$/.test(conversationId)) {
        throw new BadRequestError(
          'metadata.conversationId is required for remove_from_conversation'
        );
      }
      const conv = await Conversation.findById(conversationId);
      if (!conv) throw new NotFoundError('Target conversation not found');
      // The mod-side conversation removal lands with prompt 04 already —
      // here we just validate that the (user, conversation) pair are real.
      const user = await User.findById(input.targetId).select('_id');
      if (!user) throw new NotFoundError('Target user not found');
      return;
    }
    case MODERATION_ACTION_TYPE.LOCK_CONVERSATION: {
      const conv = await Conversation.findById(input.targetId);
      if (!conv) throw new NotFoundError('Target conversation not found');
      // Locking is conceptually a settings flip; the conversation.settings
      // schema doesn't yet have a `locked` field. The audit row is the
      // authoritative record until the schema gains the field — keeps this
      // module shippable without churning conversation.model.
      return;
    }
  }
};

const ensureReportLinkAllowed = async (
  actor: AuthenticatedActor,
  reportId: string
): Promise<void> => {
  const report = await Report.findById(reportId).select(
    '_id targetType targetId reporterId'
  );
  if (!report) throw new BadRequestError('Related report not found');
  // The reporter must not also be the moderator on their own report.
  if (report.reporterId.toString() === actor.id) {
    throw new ForbiddenError('Cannot link a moderation action to your own report');
  }
};

export const createModerationAction = async (
  actor: AuthenticatedActor,
  input: CreateModerationActionInput,
  audit: AuditContext
): Promise<ModerationActionDto> => {
  if (!actor.permissions.includes(PERMISSIONS.MODERATION_ACTION)) {
    throw new ForbiddenError('You cannot perform moderation actions');
  }

  // Validate the (action, target) combination — keeps the model honest and
  // gives clients a clear error before any DB write.
  const allowedTargets = ALLOWED_ACTION_TARGETS[input.actionType];
  if (!allowedTargets.includes(input.targetType)) {
    throw new BadRequestError(
      `Action ${input.actionType} is not valid for target ${input.targetType}`
    );
  }

  // Cannot act against yourself.
  if (
    input.targetType === MODERATION_TARGET_TYPE.USER &&
    input.targetId === actor.id
  ) {
    throw new BadRequestError('Cannot apply moderation actions to yourself');
  }

  if (input.relatedReportId) {
    await ensureReportLinkAllowed(actor, input.relatedReportId);
  }

  await applyActionSideEffect(actor, input);

  const action = await ModerationAction.create({
    moderatorId: toObjectId(actor.id),
    actionType: input.actionType,
    targetType: input.targetType,
    targetId: toObjectId(input.targetId),
    reason: input.reason,
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.relatedReportId
      ? { relatedReportId: toObjectId(input.relatedReportId) }
      : {})
  });

  auditModerationAction(audit, {
    actionId: (action._id as Types.ObjectId).toString(),
    actionType: action.actionType,
    targetType: action.targetType,
    targetId: action.targetId.toString(),
    relatedReportId: action.relatedReportId?.toString(),
    // Reason text is sensitive — we record only that one was given. The
    // persistent moderation_actions row holds the full text for review.
    hasReason: Boolean(action.reason),
    hasMetadata:
      action.metadata != null && Object.keys(action.metadata).length > 0
  });

  // Notify the affected user when the action is user-targeted. We only
  // notify on user-scoped actions; message/conversation deletions don't
  // page the author directly (the deleted-message DTO already signals
  // the change). The reason text is intentionally NOT included — only
  // the kind of action — to avoid leaking the moderator's internal notes.
  if (action.targetType === MODERATION_TARGET_TYPE.USER) {
    await createNotification({
      userId: action.targetId.toString(),
      type: NOTIFICATION_TYPE.MODERATION_ACTION,
      title: `Account update: ${action.actionType.replace(/_/g, ' ')}`,
      entityType: NOTIFICATION_ENTITY_TYPE.MODERATION_ACTION,
      entityId: (action._id as Types.ObjectId).toString(),
      data: { actionType: action.actionType }
    }).catch(() => {
      /* swallowed; the moderation action itself succeeded */
    });
  }

  return toModerationActionDto(action);
};

export const listModerationActions = async (
  actor: AuthenticatedActor,
  query: ListModerationActionsQuery
): Promise<{ items: ModerationActionDto[]; nextCursor: string | null }> => {
  if (!actor.permissions.includes(PERMISSIONS.MODERATION_ACTION)) {
    throw new ForbiddenError('You cannot view moderation actions');
  }

  const filter: FilterQuery<ModerationActionDocument> = {};
  if (query.targetType) filter.targetType = query.targetType;
  if (query.targetId) filter.targetId = toObjectId(query.targetId);
  if (query.moderatorId) filter.moderatorId = toObjectId(query.moderatorId);
  if (query.cursor) filter._id = { $lt: toObjectId(query.cursor) };

  const docs = await ModerationAction.find(filter)
    .sort({ _id: -1 })
    .limit(query.limit + 1);
  const hasMore = docs.length > query.limit;
  const page = hasMore ? docs.slice(0, query.limit) : docs;

  const lastId =
    page.length > 0 ? (page[page.length - 1]._id as Types.ObjectId).toString() : null;
  return {
    items: page.map(toModerationActionDto),
    nextCursor: hasMore ? lastId : null
  };
};
