import mongoose, { Schema, type Model, type Types } from 'mongoose';
import {
  CONVERSATION_SETTINGS_WHO_CAN_SEND,
  CONVERSATION_TYPE,
  DEFAULT_CONVERSATION_SETTINGS,
  GROUP_TITLE_MAX_LENGTH,
  type ConversationDto,
  type ConversationLastMessageDto,
  type ConversationSettings,
  type ConversationType
} from './conversation.types';

export interface ConversationLastMessage {
  messageId: Types.ObjectId;
  senderId: Types.ObjectId;
  preview: string;
  sentAt: Date;
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
  settings: ConversationSettings;
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

const settingsSchema = new Schema<ConversationSettings>(
  {
    whoCanSendMessages: {
      type: String,
      enum: [...CONVERSATION_SETTINGS_WHO_CAN_SEND],
      default: DEFAULT_CONVERSATION_SETTINGS.whoCanSendMessages,
      required: true
    }
  },
  { _id: false }
);

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
    settings: {
      type: settingsSchema,
      default: () => ({ ...DEFAULT_CONVERSATION_SETTINGS }),
      required: true
    }
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
    | (ConversationSettings & { toObject?: () => ConversationSettings })
    | undefined;
  const plain = stored?.toObject ? stored.toObject() : stored;
  return {
    whoCanSendMessages:
      plain?.whoCanSendMessages ??
      DEFAULT_CONVERSATION_SETTINGS.whoCanSendMessages
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
