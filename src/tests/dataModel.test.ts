// Cross-collection data-integrity tests.
//
// Each model file under src/modules/*/ already carries its own behavioral
// tests; this suite is the catch-all that asserts the schema-level rules
// prompt 12 requires across the entire data layer:
//   - unique indexes are present and enforced
//   - direct-conversation dedup is enforced by the unique sparse index
//   - membership uniqueness is enforced
//   - story/view/block/reaction/receipt/device uniqueness are enforced
//   - TTL indexes are declared with the right options
//   - the migration runner is idempotent
//
// Real TTL expiration is not exercised — MongoDB's TTL monitor runs on a
// 60s real-time cadence which isn't compatible with a sub-second unit test.
// We assert the index spec instead, which is the actual guarantee.

import mongoose from 'mongoose';
import { clearTestDb, startTestDb, stopTestDb } from './db';
import { buildUser, buildDirectConversation } from './factories';
import { User } from '../modules/users/user.model';
import { Session } from '../modules/sessions/session.model';
import { Conversation, buildDirectKey } from '../modules/conversations/conversation.model';
import { ConversationMember } from '../modules/conversations/conversationMember.model';
import {
  CONVERSATION_MEMBER_ROLE,
  CONVERSATION_TYPE,
  DEFAULT_CONVERSATION_SETTINGS
} from '../modules/conversations/conversation.types';
import { Message } from '../modules/messages/message.model';
import { MessageReceipt } from '../modules/messages/messageReceipt.model';
import { MessageReaction } from '../modules/messages/messageReaction.model';
import { Attachment } from '../modules/media/attachment.model';
import {
  ATTACHMENT_STATUS,
  ATTACHMENT_VISIBILITY
} from '../modules/media/media.types';
import { Story } from '../modules/stories/story.model';
import { StoryView } from '../modules/stories/storyView.model';
import { StoryMute } from '../modules/stories/storyMute.model';
import { Block } from '../modules/moderation/block.model';
import { Device } from '../modules/devices/device.model';
import { DEVICE_PLATFORM } from '../modules/devices/device.types';
import { NotificationPreference } from '../modules/notifications/notificationPreference.model';
import { runMigrations, MigrationRecord } from '../db/migrations';

const expectDuplicateKey = async (op: Promise<unknown>): Promise<void> => {
  await expect(op).rejects.toMatchObject({
    code: 11000
  });
};

const findIndex = async (
  model: mongoose.Model<unknown>,
  predicate: (spec: Record<string, unknown>) => boolean
): Promise<Record<string, unknown> | undefined> => {
  const indexes = (await model.collection.indexes()) as Record<
    string,
    unknown
  >[];
  return indexes.find(predicate);
};

beforeAll(async () => {
  await startTestDb();
});

afterAll(async () => {
  await stopTestDb();
});

afterEach(async () => {
  await clearTestDb();
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

describe('User uniqueness', () => {
  it('rejects a second user with the same email (case-insensitive)', async () => {
    await buildUser({ email: 'dup@example.com' });
    await expectDuplicateKey(
      buildUser({ email: 'DUP@example.com', username: 'other' })
    );
  });

  it('rejects a second user with the same username', async () => {
    await buildUser({ username: 'same_name', email: 'a@example.com' });
    await expectDuplicateKey(
      buildUser({ username: 'same_name', email: 'b@example.com' })
    );
  });

  it('allows multiple users with no email (sparse index)', async () => {
    await User.create({
      passwordHash: 'h',
      displayName: 'No email A',
      role: 'member'
    });
    // The sparse index treats missing values as absent — so a second
    // emailless user must not collide.
    await expect(
      User.create({
        passwordHash: 'h',
        displayName: 'No email B',
        role: 'member'
      })
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Sessions / TTL
// ---------------------------------------------------------------------------

describe('Session TTL index', () => {
  it('declares a TTL index on expiresAt with expireAfterSeconds: 0', async () => {
    const idx = await findIndex(
      Session as unknown as mongoose.Model<unknown>,
      (spec) =>
        JSON.stringify(spec.key) === JSON.stringify({ expiresAt: 1 }) &&
        spec.expireAfterSeconds === 0
    );
    expect(idx).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Conversations (direct-key dedup)
// ---------------------------------------------------------------------------

describe('Conversation direct-key uniqueness', () => {
  it('rejects a second direct conversation between the same pair (either order)', async () => {
    const a = await buildUser();
    const b = await buildUser();
    const key = buildDirectKey(a._id.toString(), b._id.toString());

    await Conversation.create({
      type: CONVERSATION_TYPE.DIRECT,
      createdBy: a._id,
      directKey: key,
      settings: { ...DEFAULT_CONVERSATION_SETTINGS }
    });

    await expectDuplicateKey(
      Conversation.create({
        type: CONVERSATION_TYPE.DIRECT,
        createdBy: b._id,
        directKey: key,
        settings: { ...DEFAULT_CONVERSATION_SETTINGS }
      })
    );
  });

  it('allows many group conversations (directKey is missing on groups)', async () => {
    const owner = await buildUser();
    // Without sparse on the unique index, a second group would collide on
    // an implicit null directKey. The current schema marks the index sparse,
    // so two groups coexist freely.
    await Conversation.create({
      type: CONVERSATION_TYPE.GROUP,
      title: 'A',
      createdBy: owner._id,
      settings: { ...DEFAULT_CONVERSATION_SETTINGS }
    });
    await expect(
      Conversation.create({
        type: CONVERSATION_TYPE.GROUP,
        title: 'B',
        createdBy: owner._id,
        settings: { ...DEFAULT_CONVERSATION_SETTINGS }
      })
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Conversation members
// ---------------------------------------------------------------------------

describe('ConversationMember uniqueness', () => {
  it('rejects a second membership for the same (conversation, user) pair', async () => {
    const a = await buildUser();
    const b = await buildUser();
    const conv = await buildDirectConversation(a, b);

    await expectDuplicateKey(
      ConversationMember.create({
        conversationId: conv._id,
        userId: a._id,
        role: CONVERSATION_MEMBER_ROLE.MEMBER
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Messages / receipts / reactions
// ---------------------------------------------------------------------------

describe('Message receipts & reactions uniqueness', () => {
  it('rejects two receipts from the same user on the same message', async () => {
    const a = await buildUser();
    const b = await buildUser();
    const conv = await buildDirectConversation(a, b);
    const msg = await Message.create({
      conversationId: conv._id,
      senderId: a._id,
      text: 'hi'
    });

    await MessageReceipt.create({
      messageId: msg._id,
      conversationId: conv._id,
      userId: b._id,
      deliveredAt: new Date()
    });
    await expectDuplicateKey(
      MessageReceipt.create({
        messageId: msg._id,
        conversationId: conv._id,
        userId: b._id,
        deliveredAt: new Date()
      })
    );
  });

  it('rejects a second identical reaction by the same user', async () => {
    const a = await buildUser();
    const b = await buildUser();
    const conv = await buildDirectConversation(a, b);
    const msg = await Message.create({
      conversationId: conv._id,
      senderId: a._id,
      text: 'hi'
    });

    await MessageReaction.create({
      messageId: msg._id,
      conversationId: conv._id,
      userId: b._id,
      emoji: '👍'
    });
    await expectDuplicateKey(
      MessageReaction.create({
        messageId: msg._id,
        conversationId: conv._id,
        userId: b._id,
        emoji: '👍'
      })
    );
  });

  it('allows distinct emoji from the same user on the same message', async () => {
    const a = await buildUser();
    const b = await buildUser();
    const conv = await buildDirectConversation(a, b);
    const msg = await Message.create({
      conversationId: conv._id,
      senderId: a._id,
      text: 'hi'
    });

    await MessageReaction.create({
      messageId: msg._id,
      conversationId: conv._id,
      userId: b._id,
      emoji: '👍'
    });
    await expect(
      MessageReaction.create({
        messageId: msg._id,
        conversationId: conv._id,
        userId: b._id,
        emoji: '❤️'
      })
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

describe('Attachment storageKey uniqueness', () => {
  it('rejects two attachments pointing at the same storage key', async () => {
    const owner = await buildUser();
    const baseAttrs = {
      ownerId: owner._id,
      storageProvider: 'memory',
      storageKey: 'attachments/abc.bin',
      originalFilename: 'a.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: 10,
      status: ATTACHMENT_STATUS.PENDING,
      visibility: ATTACHMENT_VISIBILITY.PRIVATE
    };
    await Attachment.create(baseAttrs);
    await expectDuplicateKey(Attachment.create(baseAttrs));
  });
});

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

describe('Story views & mutes uniqueness', () => {
  it('rejects a second view from the same viewer on the same story', async () => {
    const author = await buildUser();
    const viewer = await buildUser();
    const story = await Story.create({
      authorId: author._id,
      mediaAttachmentIds: [],
      audienceType: 'everyone',
      selectedUserIds: [],
      excludedUserIds: [],
      expiresAt: new Date(Date.now() + 60_000)
    });

    await StoryView.create({ storyId: story._id, viewerId: viewer._id });
    await expectDuplicateKey(
      StoryView.create({ storyId: story._id, viewerId: viewer._id })
    );
  });

  it('rejects a second mute of the same author by the same user', async () => {
    const user = await buildUser();
    const author = await buildUser();
    await StoryMute.create({
      userId: user._id,
      mutedUserId: author._id
    });
    await expectDuplicateKey(
      StoryMute.create({
        userId: user._id,
        mutedUserId: author._id
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

describe('Block uniqueness', () => {
  it('rejects a duplicate (blocker, blocked) row', async () => {
    const a = await buildUser();
    const b = await buildUser();
    await Block.create({ blockerId: a._id, blockedUserId: b._id });
    await expectDuplicateKey(
      Block.create({ blockerId: a._id, blockedUserId: b._id })
    );
  });

  it('allows the reverse direction as a separate row', async () => {
    const a = await buildUser();
    const b = await buildUser();
    await Block.create({ blockerId: a._id, blockedUserId: b._id });
    await expect(
      Block.create({ blockerId: b._id, blockedUserId: a._id })
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Notification preferences
// ---------------------------------------------------------------------------

describe('NotificationPreference uniqueness', () => {
  it('rejects two preference rows for the same user', async () => {
    const user = await buildUser();
    await NotificationPreference.create({
      userId: user._id,
      pushEnabled: true,
      emailEnabled: false,
      messagePreviewEnabled: true,
      mutedConversationIds: []
    });
    await expectDuplicateKey(
      NotificationPreference.create({
        userId: user._id,
        pushEnabled: false,
        emailEnabled: false,
        messagePreviewEnabled: false,
        mutedConversationIds: []
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

describe('Device model', () => {
  it('rejects two devices with the same push token', async () => {
    const user = await buildUser();
    const other = await buildUser();
    await Device.create({
      userId: user._id,
      platform: DEVICE_PLATFORM.IOS,
      pushToken: 'token-xyz'
    });
    await expectDuplicateKey(
      Device.create({
        userId: other._id,
        platform: DEVICE_PLATFORM.ANDROID,
        pushToken: 'token-xyz'
      })
    );
  });

  it('hides pushToken from default reads (select: false)', async () => {
    const user = await buildUser();
    await Device.create({
      userId: user._id,
      platform: DEVICE_PLATFORM.WEB,
      pushToken: 'should-not-be-returned'
    });
    const fetched = await Device.findOne({ userId: user._id });
    expect(fetched).not.toBeNull();
    // pushToken is `select: false`, so it must not be present without an
    // explicit opt-in.
    expect((fetched as unknown as { pushToken?: string }).pushToken).toBeUndefined();

    // Opt-in path still returns it for the push fan-out worker.
    const withToken = await Device.findOne({ userId: user._id }).select(
      '+pushToken'
    );
    expect((withToken as unknown as { pushToken?: string }).pushToken).toBe(
      'should-not-be-returned'
    );
  });

  it('rejects an unknown platform value', async () => {
    const user = await buildUser();
    await expect(
      // Cast through `unknown` to bypass the DevicePlatform string-union and
      // verify the schema's enum validator (not the type system) rejects it.
      Device.create({
        userId: user._id,
        platform: 'palm-os' as unknown as 'ios',
        pushToken: 't'
      })
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

describe('Migration runner', () => {
  it('applies each migration once and skips on a second run', async () => {
    // After startTestDb() the migrations collection is empty (a fresh in-memory
    // database is brought up per test file). The first invocation applies
    // every migration; the second invocation must report every migration as
    // skipped because the MigrationRecord rows already exist.
    const first = await runMigrations();
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((r) => r.status === 'applied')).toBe(true);

    const second = await runMigrations();
    expect(second).toHaveLength(first.length);
    expect(second.every((r) => r.status === 'skipped')).toBe(true);
  });

  it('records each migration name uniquely', async () => {
    await runMigrations();
    const records = await MigrationRecord.find().sort({ name: 1 });
    const names = records.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('0001-sync-indexes');
    expect(names).toContain('0002-backfill-conversation-direct-key');
  });

  it('rejects a duplicate MigrationRecord (unique index enforced)', async () => {
    await MigrationRecord.create({
      name: 'fake-test-migration',
      appliedAt: new Date(),
      durationMs: 1
    });
    await expectDuplicateKey(
      MigrationRecord.create({
        name: 'fake-test-migration',
        appliedAt: new Date(),
        durationMs: 2
      })
    );
  });
});

describe('Backfill-direct-key migration', () => {
  it('fills directKey on legacy direct conversations and stays a no-op afterwards', async () => {
    const a = await buildUser();
    const b = await buildUser();

    // Simulate a legacy row: create the conversation, then strip directKey
    // with a raw update so we end up in the pre-migration state.
    const conv = await Conversation.create({
      type: CONVERSATION_TYPE.DIRECT,
      createdBy: a._id,
      directKey: buildDirectKey(a._id.toString(), b._id.toString()),
      settings: { ...DEFAULT_CONVERSATION_SETTINGS }
    });
    await Conversation.collection.updateOne(
      { _id: conv._id },
      { $unset: { directKey: '' } }
    );
    await ConversationMember.insertMany([
      {
        conversationId: conv._id,
        userId: a._id,
        role: CONVERSATION_MEMBER_ROLE.MEMBER
      },
      {
        conversationId: conv._id,
        userId: b._id,
        role: CONVERSATION_MEMBER_ROLE.MEMBER
      }
    ]);

    // Clear MigrationRecord so the runner actually executes 0002 again.
    await MigrationRecord.deleteMany({});

    await runMigrations();

    const after = await Conversation.findById(conv._id);
    expect(after?.directKey).toBe(
      buildDirectKey(a._id.toString(), b._id.toString())
    );

    // Re-running must be a no-op even when the row is now correctly keyed.
    await MigrationRecord.deleteOne({
      name: '0002-backfill-conversation-direct-key'
    });
    await expect(runMigrations()).resolves.toBeDefined();
    const stillCorrect = await Conversation.findById(conv._id);
    expect(stillCorrect?.directKey).toBe(after?.directKey);
  });
});
