import mongoose, { Schema, type Model, type Types } from 'mongoose';
import {
  CONVERSATION_SETTINGS_WHO_CAN_SEND,
  CONVERSATION_TYPE,
  DEFAULT_CONVERSATION_SETTINGS,
  DEFAULT_DISAPPEARING_SETTINGS,
  DISAPPEARING_MESSAGE_DURATIONS,
  GROUP_TITLE_MAX_LENGTH,
  type ConversationDto,
  type ConversationLastMessageDto,
  type ConversationSettings,
  type ConversationType,
  type DisappearingMessageSettings
} from './conversation.types';

export interface ConversationLastMessage {
  messageId: Types.ObjectId;
  senderId: Types.ObjectId;
  preview: string;
  sentAt: Date;
}

export interface ConversationDisappearingMessages {
  duration: DisappearingMessageSettings['duration'];
  durationSeconds: number;
  updatedBy?: Types.ObjectId;
  updatedAt?: Date;
}

export interface ConversationStoredSettings {
  whoCanSendMessages: ConversationSettings['whoCanSendMessages'];
  disappearingMessages: ConversationDisappearingMessages;
}

export interface ConversationAttrs {
  type: ConversationType;
  title?: string;
  avatarUrl?: string;
  createdBy: Types.ObjectId;
  // Sorted, joined participant ids for direct conversations. Unique sparse
  // index enforces "at most one direct conversation per ordered pair" without
  // a separate dedup query.
  directKey?: string;
  lastMessage?: ConversationLastMessage;
  settings: ConversationStoredSettings;
}

export interface ConversationDocument
  extends ConversationAttrs,
    mongoose.Document {
  createdAt: Date;
  updatedAt: Date;
}

const lastMessageSchema = new Schema<ConversationLastMessage>(
  {
    messageId: { type: Schema.Types.ObjectId, required: true },
    senderId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    // Preview is the truncated text used for inbox listings. Never store the
    // full message body here — that lives on the message document itself.
    preview: { type: String, required: true, maxlength: 200 },
    sentAt: { type: Date, required: true }
  },
  { _id: false }
);

// Settings live as an inline nested schema on the parent. We keep the
// definition object out of the parent literal only to keep it readable.
const settingsSchemaDefinition = {
  whoCanSendMessages: {
    type: String,
    enum: [...CONVERSATION_SETTINGS_WHO_CAN_SEND],
    default: DEFAULT_CONVERSATION_SETTINGS.whoCanSendMessages,
    required: true
  },
  disappearingMessages: {
    duration: {
      type: String,
      enum: [...DISAPPEARING_MESSAGE_DURATIONS],
      default: DEFAULT_DISAPPEARING_SETTINGS.duration,
      required: true
    },
    // Mirrors `duration` (0 when duration === 'off'). Kept here so the
    // message-send path can pick up the value with the conversation fetch
    // it already does, without re-mapping the enum on every write.
    durationSeconds: {
      type: Number,
      default: DEFAULT_DISAPPEARING_SETTINGS.durationSeconds,
      required: true,
      min: 0
    },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedAt: { type: Date }
  }
} as const;

const conversationSchema = new Schema<ConversationDocument>(
  {
    type: {
      type: String,
      enum: Object.values(CONVERSATION_TYPE),
      required: true
    },
    title: { type: String, trim: true, maxlength: GROUP_TITLE_MAX_LENGTH },
    avatarUrl: { type: String, trim: true, maxlength: 2048 },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    directKey: {
      type: String,
      index: { unique: true, sparse: true }
    },
    lastMessage: { type: lastMessageSchema },
    settings: settingsSchemaDefinition
  },
  { timestamps: true, strict: 'throw' }
);

// Inbox listings filter on updatedAt desc per user; the heavy index is on
// ConversationMember (userId), and this helps the secondary lookup.
conversationSchema.index({ updatedAt: -1 });

export const buildDirectKey = (userIdA: string, userIdB: string): string => {
  const [first, second] = [userIdA, userIdB].sort();
  return `${first}:${second}`;
};

const resolveSettings = (
  doc: ConversationDocument
): ConversationSettings => {
  const stored = doc.settings as unknown as
    | (ConversationStoredSettings & {
        toObject?: () => ConversationStoredSettings;
      })
    | undefined;
  const plain = stored?.toObject ? stored.toObject() : stored;
  const dm = plain?.disappearingMessages;
  const disappearingDto: DisappearingMessageSettings = {
    duration: dm?.duration ?? DEFAULT_DISAPPEARING_SETTINGS.duration,
    durationSeconds:
      dm?.durationSeconds ?? DEFAULT_DISAPPEARING_SETTINGS.durationSeconds
  };
  if (dm?.updatedBy) {
    disappearingDto.updatedBy = dm.updatedBy.toString();
  }
  if (dm?.updatedAt) {
    disappearingDto.updatedAt = dm.updatedAt.toISOString();
  }
  return {
    whoCanSendMessages:
      plain?.whoCanSendMessages ??
      DEFAULT_CONVERSATION_SETTINGS.whoCanSendMessages,
    disappearingMessages: disappearingDto
  };
};

const resolveLastMessage = (
  doc: ConversationDocument
): ConversationLastMessageDto | undefined => {
  if (!doc.lastMessage) return undefined;
  return {
    messageId: doc.lastMessage.messageId.toString(),
    senderId: doc.lastMessage.senderId.toString(),
    preview: doc.lastMessage.preview,
    sentAt: doc.lastMessage.sentAt.toISOString()
  };
};

export const toConversationDto = (
  doc: ConversationDocument
): ConversationDto => {
  const dto: ConversationDto = {
    id: (doc._id as Types.ObjectId).toString(),
    type: doc.type,
    createdBy: doc.createdBy.toString(),
    settings: resolveSettings(doc),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString()
  };
  if (doc.title) dto.title = doc.title;
  if (doc.avatarUrl) dto.avatarUrl = doc.avatarUrl;
  const lastMessage = resolveLastMessage(doc);
  if (lastMessage) dto.lastMessage = lastMessage;
  return dto;
};

export const Conversation: Model<ConversationDocument> =
  (mongoose.models.Conversation as Model<ConversationDocument>) ||
  mongoose.model<ConversationDocument>('Conversation', conversationSchema);
