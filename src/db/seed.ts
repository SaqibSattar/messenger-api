// Dev-only seed script: `npm run seed:dev`. Creates a small, deterministic
// fixture set (a handful of users, a direct conversation, a small group)
// against the configured MongoDB so a developer can hit the API right after
// `npm run dev` without going through registration by hand.
//
// Safety rails:
//   - Refuses to run when NODE_ENV=production. Seeding production with
//     known-password test users would be a credential leak.
//   - Refuses to run when the existing user count is above a small
//     threshold — that's the heuristic for "this is not an empty dev DB".
//     Override with SEED_FORCE=1 only when you actually mean it.
//   - Idempotent: each entity is upserted on a stable unique key so
//     running the script twice doesn't duplicate rows.

import argon2 from 'argon2';
import { connectMongo, disconnectMongo } from './mongo';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { User } from '../modules/users/user.model';
import { ROLES } from '../modules/permissions/permissions.constants';
import { USER_STATUS } from '../modules/users/user.types';
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

const SEED_PASSWORD = 'SeedPassword!23';

const SEED_USERS = [
  { email: 'alice@seed.local', displayName: 'Alice (seed)', role: ROLES.MEMBER },
  { email: 'bob@seed.local', displayName: 'Bob (seed)', role: ROLES.MEMBER },
  { email: 'carol@seed.local', displayName: 'Carol (seed)', role: ROLES.MEMBER },
  { email: 'mod@seed.local', displayName: 'Mod (seed)', role: ROLES.MODERATOR }
] as const;

const upsertUser = async (
  attrs: (typeof SEED_USERS)[number]
): Promise<string> => {
  const existing = await User.findOne({ email: attrs.email });
  if (existing) return existing._id.toString();

  const passwordHash = await argon2.hash(SEED_PASSWORD);
  const created = await User.create({
    email: attrs.email,
    passwordHash,
    displayName: attrs.displayName,
    role: attrs.role,
    status: USER_STATUS.ACTIVE
  });
  return created._id.toString();
};

const upsertDirectConversation = async (
  userIdA: string,
  userIdB: string
): Promise<void> => {
  const directKey = buildDirectKey(userIdA, userIdB);
  let conv = await Conversation.findOne({ directKey });
  if (!conv) {
    conv = await Conversation.create({
      type: CONVERSATION_TYPE.DIRECT,
      createdBy: userIdA,
      directKey,
      settings: { ...DEFAULT_CONVERSATION_SETTINGS }
    });
  }

  // Memberships use the unique (conversationId, userId) index, so each
  // upsert is an atomic no-op when the row already exists.
  await ConversationMember.updateOne(
    { conversationId: conv._id, userId: userIdA },
    { $setOnInsert: { role: CONVERSATION_MEMBER_ROLE.MEMBER } },
    { upsert: true }
  );
  await ConversationMember.updateOne(
    { conversationId: conv._id, userId: userIdB },
    { $setOnInsert: { role: CONVERSATION_MEMBER_ROLE.MEMBER } },
    { upsert: true }
  );
};

const upsertGroupConversation = async (
  title: string,
  ownerId: string,
  memberIds: string[]
): Promise<void> => {
  // Group conversations don't have a `directKey`, so we look up by
  // (type, title, createdBy) which is stable for the seed set.
  let conv = await Conversation.findOne({
    type: CONVERSATION_TYPE.GROUP,
    title,
    createdBy: ownerId
  });
  if (!conv) {
    conv = await Conversation.create({
      type: CONVERSATION_TYPE.GROUP,
      title,
      createdBy: ownerId,
      settings: { ...DEFAULT_CONVERSATION_SETTINGS }
    });
  }

  await ConversationMember.updateOne(
    { conversationId: conv._id, userId: ownerId },
    { $setOnInsert: { role: CONVERSATION_MEMBER_ROLE.OWNER } },
    { upsert: true }
  );
  for (const memberId of memberIds) {
    await ConversationMember.updateOne(
      { conversationId: conv._id, userId: memberId },
      { $setOnInsert: { role: CONVERSATION_MEMBER_ROLE.MEMBER } },
      { upsert: true }
    );
  }
};

export const seedDev = async (): Promise<void> => {
  if (env.isProd) {
    throw new Error('seedDev: refusing to run in production');
  }

  const existingCount = await User.countDocuments();
  if (existingCount > 20 && process.env.SEED_FORCE !== '1') {
    throw new Error(
      `seedDev: refusing to run on a database with ${existingCount} users — set SEED_FORCE=1 to override`
    );
  }

  const ids: Record<string, string> = {};
  for (const user of SEED_USERS) {
    ids[user.email] = await upsertUser(user);
  }

  await upsertDirectConversation(
    ids['alice@seed.local'],
    ids['bob@seed.local']
  );

  await upsertGroupConversation(
    'Seed Group',
    ids['alice@seed.local'],
    [ids['bob@seed.local'], ids['carol@seed.local']]
  );

  logger.info(
    { users: Object.keys(ids).length, password: SEED_PASSWORD },
    'seed complete'
  );
};

// Allow `node dist/db/seed.js` / `tsx src/db/seed.ts` to execute the seed
// standalone. When imported (e.g. by a test) the side effect doesn't run.
if (require.main === module) {
  (async (): Promise<void> => {
    await connectMongo();
    try {
      await seedDev();
    } finally {
      await disconnectMongo();
    }
  })().catch((err) => {
    logger.error({ err }, 'seed failed');
    process.exit(1);
  });
}
