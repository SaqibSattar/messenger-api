// Shared test data builders. Tests can either use these or write their own
// per-suite helpers — both patterns are fine. The factories here exist so
// the cross-collection data-integrity tests (src/tests/dataModel.test.ts)
// can spin up valid rows without each test re-deriving the minimal set of
// required fields for every model.
//
// These factories deliberately use cheap/deterministic values rather than
// argon2 hashes or other expensive setup, since the data-model tests don't
// exercise auth or business logic — they only verify schema-level
// constraints. Suites that DO exercise auth should keep using argon2 in
// their own seed helpers.

import mongoose, { type Types } from 'mongoose';
import { User } from '../modules/users/user.model';
import { ROLES } from '../modules/permissions/permissions.constants';
import {
  Conversation,
  buildDirectKey
} from '../modules/conversations/conversation.model';
import { ConversationMember } from '../modules/conversations/conversationMember.model';
import {
  CONVERSATION_MEMBER_ROLE,
  CONVERSATION_TYPE,
  DEFAULT_CONVERSATION_SETTINGS
} from '../modules/conversations/conversation.types';
import { Message } from '../modules/messages/message.model';
import type { UserDocument } from '../modules/users/user.model';
import type { ConversationDocument } from '../modules/conversations/conversation.model';

let counter = 0;
const uniq = (): number => ++counter;

// Cheap placeholder hash. These factories never authenticate, so the value
// only has to satisfy the required-string schema constraint — argon2 cost
// would only slow the test suite.
const PLACEHOLDER_PASSWORD_HASH = 'placeholder-hash-not-used-for-auth';

export const buildUser = async (
  overrides: Partial<{
    email: string;
    username: string;
    displayName: string;
  }> = {}
): Promise<UserDocument> => {
  const n = uniq();
  return User.create({
    email: overrides.email ?? `user-${n}@factory.local`,
    username: overrides.username ?? `user_${n}`,
    passwordHash: PLACEHOLDER_PASSWORD_HASH,
    displayName: overrides.displayName ?? `User ${n}`,
    role: ROLES.MEMBER
  });
};

export const buildDirectConversation = async (
  userA: UserDocument,
  userB: UserDocument
): Promise<ConversationDocument> => {
  const directKey = buildDirectKey(
    userA._id.toString(),
    userB._id.toString()
  );
  const conv = await Conversation.create({
    type: CONVERSATION_TYPE.DIRECT,
    createdBy: userA._id,
    directKey,
    settings: { ...DEFAULT_CONVERSATION_SETTINGS }
  });
  await ConversationMember.insertMany([
    {
      conversationId: conv._id,
      userId: userA._id,
      role: CONVERSATION_MEMBER_ROLE.MEMBER
    },
    {
      conversationId: conv._id,
      userId: userB._id,
      role: CONVERSATION_MEMBER_ROLE.MEMBER
    }
  ]);
  return conv;
};

export const buildMessage = async (
  conversation: ConversationDocument,
  sender: UserDocument,
  overrides: Partial<{ text: string; expiresAt: Date }> = {}
): Promise<mongoose.Document & { _id: Types.ObjectId }> => {
  return Message.create({
    conversationId: conversation._id,
    senderId: sender._id,
    text: overrides.text ?? `msg ${uniq()}`,
    ...(overrides.expiresAt ? { expiresAt: overrides.expiresAt } : {})
  }) as unknown as mongoose.Document & { _id: Types.ObjectId };
};
