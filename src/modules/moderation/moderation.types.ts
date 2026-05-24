export const MODERATION_ACTION_TYPE = {
  WARN_USER: 'warn_user',
  SUSPEND_USER: 'suspend_user',
  RESTORE_USER: 'restore_user',
  DELETE_MESSAGE: 'delete_message',
  HIDE_MESSAGE: 'hide_message',
  REMOVE_STORY: 'remove_story',
  REMOVE_FROM_CONVERSATION: 'remove_from_conversation',
  LOCK_CONVERSATION: 'lock_conversation'
} as const;

export type ModerationActionType =
  (typeof MODERATION_ACTION_TYPE)[keyof typeof MODERATION_ACTION_TYPE];

export const MODERATION_ACTION_TYPES: readonly ModerationActionType[] =
  Object.values(MODERATION_ACTION_TYPE);

export const MODERATION_TARGET_TYPE = {
  USER: 'user',
  MESSAGE: 'message',
  CONVERSATION: 'conversation',
  STORY: 'story'
} as const;

export type ModerationTargetType =
  (typeof MODERATION_TARGET_TYPE)[keyof typeof MODERATION_TARGET_TYPE];

export const MODERATION_TARGET_TYPES: readonly ModerationTargetType[] =
  Object.values(MODERATION_TARGET_TYPE);

// Which target types each action type is valid against. Anything not in this
// map is rejected at validation time — keeps the model honest.
export const ALLOWED_ACTION_TARGETS: Record<
  ModerationActionType,
  readonly ModerationTargetType[]
> = {
  [MODERATION_ACTION_TYPE.WARN_USER]: [MODERATION_TARGET_TYPE.USER],
  [MODERATION_ACTION_TYPE.SUSPEND_USER]: [MODERATION_TARGET_TYPE.USER],
  [MODERATION_ACTION_TYPE.RESTORE_USER]: [MODERATION_TARGET_TYPE.USER],
  [MODERATION_ACTION_TYPE.DELETE_MESSAGE]: [MODERATION_TARGET_TYPE.MESSAGE],
  [MODERATION_ACTION_TYPE.HIDE_MESSAGE]: [MODERATION_TARGET_TYPE.MESSAGE],
  [MODERATION_ACTION_TYPE.REMOVE_STORY]: [MODERATION_TARGET_TYPE.STORY],
  [MODERATION_ACTION_TYPE.REMOVE_FROM_CONVERSATION]: [MODERATION_TARGET_TYPE.USER],
  [MODERATION_ACTION_TYPE.LOCK_CONVERSATION]: [MODERATION_TARGET_TYPE.CONVERSATION]
};

export const MODERATION_REASON_MAX_LENGTH = 1000;

export const LIST_ACTIONS_DEFAULT_LIMIT = 25;
export const LIST_ACTIONS_MAX_LIMIT = 100;

export interface ModerationActionDto {
  id: string;
  moderatorId: string;
  actionType: ModerationActionType;
  targetType: ModerationTargetType;
  targetId: string;
  reason: string;
  metadata?: Record<string, unknown>;
  relatedReportId?: string;
  createdAt: string;
}
