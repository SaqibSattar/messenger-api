export const REPORT_TARGET_TYPE = {
  USER: 'user',
  MESSAGE: 'message',
  CONVERSATION: 'conversation'
} as const;

export type ReportTargetType =
  (typeof REPORT_TARGET_TYPE)[keyof typeof REPORT_TARGET_TYPE];

export const REPORT_TARGET_TYPES: readonly ReportTargetType[] = [
  REPORT_TARGET_TYPE.USER,
  REPORT_TARGET_TYPE.MESSAGE,
  REPORT_TARGET_TYPE.CONVERSATION
];

export const REPORT_REASON = {
  SPAM: 'spam',
  HARASSMENT: 'harassment',
  HATE_SPEECH: 'hate_speech',
  VIOLENCE: 'violence',
  SEXUAL_CONTENT: 'sexual_content',
  CSAM: 'csam',
  SELF_HARM: 'self_harm',
  IMPERSONATION: 'impersonation',
  SCAM: 'scam',
  OTHER: 'other'
} as const;

export type ReportReason = (typeof REPORT_REASON)[keyof typeof REPORT_REASON];

export const REPORT_REASONS: readonly ReportReason[] = Object.values(REPORT_REASON);

export const REPORT_STATUS = {
  OPEN: 'open',
  REVIEWING: 'reviewing',
  RESOLVED: 'resolved',
  DISMISSED: 'dismissed'
} as const;

export type ReportStatus = (typeof REPORT_STATUS)[keyof typeof REPORT_STATUS];

export const REPORT_STATUSES: readonly ReportStatus[] = Object.values(REPORT_STATUS);

export const REPORT_DETAILS_MAX_LENGTH = 2000;

export const LIST_REPORTS_DEFAULT_LIMIT = 25;
export const LIST_REPORTS_MAX_LIMIT = 100;

// Status transitions allowed for reviewers. A report cannot move backwards
// from a terminal state (resolved/dismissed) without explicit re-open, which
// we do not expose — keeps the audit timeline append-only.
export const ALLOWED_STATUS_TRANSITIONS: Record<ReportStatus, readonly ReportStatus[]> = {
  [REPORT_STATUS.OPEN]: [REPORT_STATUS.REVIEWING, REPORT_STATUS.RESOLVED, REPORT_STATUS.DISMISSED],
  [REPORT_STATUS.REVIEWING]: [REPORT_STATUS.RESOLVED, REPORT_STATUS.DISMISSED],
  [REPORT_STATUS.RESOLVED]: [],
  [REPORT_STATUS.DISMISSED]: []
};

export interface ReportDto {
  id: string;
  reporterId: string;
  targetType: ReportTargetType;
  targetId: string;
  reason: ReportReason;
  details?: string;
  status: ReportStatus;
  assignedTo?: string;
  resolvedAt?: string;
  createdAt: string;
  updatedAt: string;
}
