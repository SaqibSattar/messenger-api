import mongoose, { type FilterQuery, type Types } from 'mongoose';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError
} from '../../utils/errors';
import {
  auditReportCreated,
  auditReportStatusChanged
} from '../../utils/audit';
import type { AuditContext } from '../../utils/audit';
import {
  assertCanReadOwnReport,
  assertCanReviewReport,
  type AuthenticatedActor
} from '../permissions/authorization';
import { PERMISSIONS } from '../permissions/permissions.constants';
import { createNotification } from '../notifications/notification.service';
import {
  NOTIFICATION_ENTITY_TYPE,
  NOTIFICATION_TYPE
} from '../notifications/notification.types';
import { User } from '../users/user.model';
import { USER_STATUS } from '../users/user.types';
import { Conversation } from '../conversations/conversation.model';
import { ConversationMember } from '../conversations/conversationMember.model';
import { Message } from '../messages/message.model';
import {
  Report,
  toReporterListReportDto,
  toReportDto,
  type ReportDocument
} from './report.model';
import {
  ALLOWED_STATUS_TRANSITIONS,
  REPORT_STATUS,
  REPORT_TARGET_TYPE,
  type ReportDto,
  type ReportStatus,
  type ReportTargetType
} from './report.types';
import type {
  CreateReportInput,
  ListReportsQuery,
  UpdateReportStatusInput
} from './report.validation';

const toObjectId = (id: string): Types.ObjectId => new mongoose.Types.ObjectId(id);

// Verify the report target actually exists and that the reporter has a
// plausible vantage point (e.g. can see the message they're reporting). This
// is not an authorization check on viewing the *target* — moderators still
// inspect those — but it stops drive-by reports that name random ObjectIds.
const ensureTargetIsReportable = async (
  reporterId: string,
  targetType: ReportTargetType,
  targetId: string
): Promise<void> => {
  if (targetType === REPORT_TARGET_TYPE.USER) {
    if (reporterId === targetId) {
      throw new BadRequestError('You cannot report yourself');
    }
    const user = await User.findById(targetId).select('_id status');
    if (!user) throw new NotFoundError('Target not found');
    return;
  }

  if (targetType === REPORT_TARGET_TYPE.CONVERSATION) {
    const conv = await Conversation.findById(targetId).select('_id');
    if (!conv) throw new NotFoundError('Target not found');
    // Reporter must be (or have been) a participant. We accept past members
    // too — a user who left a toxic group still has standing to report it.
    const wasMember = await ConversationMember.exists({
      conversationId: toObjectId(targetId),
      userId: toObjectId(reporterId)
    });
    if (!wasMember) {
      throw new ForbiddenError('You cannot report this conversation');
    }
    return;
  }

  if (targetType === REPORT_TARGET_TYPE.MESSAGE) {
    const msg = await Message.findById(targetId).select(
      '_id conversationId senderId'
    );
    if (!msg) throw new NotFoundError('Target not found');
    if (msg.senderId.toString() === reporterId) {
      throw new BadRequestError('You cannot report your own message');
    }
    const wasMember = await ConversationMember.exists({
      conversationId: msg.conversationId,
      userId: toObjectId(reporterId)
    });
    if (!wasMember) {
      // Hide existence — a non-member must not learn that a given message id
      // points to a real message inside a conversation they can't see.
      throw new NotFoundError('Target not found');
    }
    return;
  }
};

export const createReport = async (
  actor: AuthenticatedActor,
  input: CreateReportInput,
  audit: AuditContext
): Promise<ReportDto> => {
  await ensureTargetIsReportable(actor.id, input.targetType, input.targetId);

  const report = await Report.create({
    reporterId: toObjectId(actor.id),
    targetType: input.targetType,
    targetId: toObjectId(input.targetId),
    reason: input.reason,
    ...(input.details ? { details: input.details } : {}),
    status: REPORT_STATUS.OPEN
  });

  await auditReportCreated(audit, {
    reportId: (report._id as Types.ObjectId).toString(),
    targetType: report.targetType,
    targetId: report.targetId.toString(),
    reason: report.reason,
    hasDetails: Boolean(report.details)
  });

  // Reporter sees their own submission with details included — they wrote
  // them and can confirm what was sent.
  return toReportDto(report);
};

const actorCanReview = (actor: AuthenticatedActor): boolean =>
  actor.permissions.includes(PERMISSIONS.REPORT_REVIEW);

export const listReports = async (
  actor: AuthenticatedActor,
  query: ListReportsQuery
): Promise<{ items: ReportDto[]; nextCursor: string | null }> => {
  const isReviewer = actorCanReview(actor);
  const mineOnly = query.mine === true || !isReviewer;

  // Non-reviewers always get scoped to their own reports — never let the
  // `mine=false` flag escape the permission boundary.
  const filter: FilterQuery<ReportDocument> = {};
  if (mineOnly) {
    filter.reporterId = toObjectId(actor.id);
  }
  if (query.status) filter.status = query.status;
  if (query.targetType) filter.targetType = query.targetType;
  if (query.cursor) {
    filter._id = { $lt: toObjectId(query.cursor) };
  }

  const docs = await Report.find(filter)
    .sort({ _id: -1 })
    .limit(query.limit + 1);

  const hasMore = docs.length > query.limit;
  const page = hasMore ? docs.slice(0, query.limit) : docs;

  // Mask the free-text body in listings — reviewers see it via the detail
  // endpoint; reporters already know what they wrote.
  const items = page.map(toReporterListReportDto);

  const lastId =
    page.length > 0 ? (page[page.length - 1]._id as Types.ObjectId).toString() : null;
  return {
    items,
    nextCursor: hasMore ? lastId : null
  };
};

export const getReport = async (
  actor: AuthenticatedActor,
  reportId: string
): Promise<ReportDto> => {
  const report = await Report.findById(reportId);
  if (!report) throw new NotFoundError('Report not found');

  // Two-layer authorization: reviewers always pass; non-reviewers pass only
  // when they are the reporter.
  assertCanReadOwnReport(
    { id: (report._id as Types.ObjectId).toString(), reporterId: report.reporterId.toString() },
    actor
  );

  // Reviewers and the reporter both get the full body — the reporter wrote
  // it; the reviewer needs it to act.
  return toReportDto(report);
};

export const updateReportStatus = async (
  actor: AuthenticatedActor,
  reportId: string,
  input: UpdateReportStatusInput,
  audit: AuditContext
): Promise<ReportDto> => {
  const report = await Report.findById(reportId);
  if (!report) throw new NotFoundError('Report not found');

  assertCanReviewReport(
    { id: (report._id as Types.ObjectId).toString(), reporterId: report.reporterId.toString() },
    actor
  );

  // Block reviewers from acting on their own reports — separation of duties.
  if (report.reporterId.toString() === actor.id) {
    throw new ForbiddenError('Cannot review your own report');
  }

  const previousStatus: ReportStatus = report.status;
  if (previousStatus === input.status) {
    return toReportDto(report);
  }

  const allowedNext = ALLOWED_STATUS_TRANSITIONS[previousStatus];
  if (!allowedNext.includes(input.status)) {
    throw new BadRequestError(
      `Cannot transition report from ${previousStatus} to ${input.status}`
    );
  }

  report.status = input.status;
  report.assignedTo = toObjectId(actor.id);
  if (
    input.status === REPORT_STATUS.RESOLVED ||
    input.status === REPORT_STATUS.DISMISSED
  ) {
    report.resolvedAt = new Date();
  }
  await report.save();

  await auditReportStatusChanged(audit, {
    reportId: (report._id as Types.ObjectId).toString(),
    previousStatus,
    newStatus: input.status,
    targetType: report.targetType,
    targetId: report.targetId.toString(),
    // Never log the reviewer's free-text note body — only the fact one was
    // present. The persistent audit row captures `hasNote: true|false`.
    hasNote: Boolean(input.note)
  });

  // Notify the reporter that their report moved forward. Best-effort: a
  // notification failure must not undo the status change. The notification
  // payload never carries the reviewer's note — that field is sensitive
  // and stays inside the persistent report record for reviewer eyes only.
  await createNotification({
    userId: report.reporterId.toString(),
    type: NOTIFICATION_TYPE.REPORT_STATUS_CHANGED,
    title: `Your report is ${input.status}`,
    entityType: NOTIFICATION_ENTITY_TYPE.REPORT,
    entityId: (report._id as Types.ObjectId).toString(),
    data: {
      previousStatus,
      newStatus: input.status
    }
  }).catch(() => {
    /* swallowed; the status change itself succeeded */
  });

  return toReportDto(report);
};

// Used elsewhere (e.g. user deletion flows) to confirm a user has any open
// reports against them. Kept here so the schema decisions stay co-located.
export const hasOpenReportsAgainstUser = async (
  userId: string
): Promise<boolean> => {
  const open = await Report.exists({
    targetType: REPORT_TARGET_TYPE.USER,
    targetId: toObjectId(userId),
    status: { $in: [REPORT_STATUS.OPEN, REPORT_STATUS.REVIEWING] }
  });
  return open !== null;
};

// Defensive helper: confirm a user is actually active before letting them
// participate in moderation flows that read user records.
export const ensureActiveUser = async (userId: string): Promise<void> => {
  const u = await User.findById(userId).select('_id status');
  if (!u || u.status !== USER_STATUS.ACTIVE) {
    throw new NotFoundError('User not found');
  }
};
