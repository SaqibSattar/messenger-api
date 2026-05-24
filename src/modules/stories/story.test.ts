import request from 'supertest';
import argon2 from 'argon2';
import mongoose from 'mongoose';
import { buildApp } from '../../app';
import { clearTestDb, startTestDb, stopTestDb } from '../../tests/db';
import { User } from '../users/user.model';
import { ROLES, type Role } from '../permissions/permissions.constants';
import { Story } from './story.model';
import { StoryView } from './storyView.model';
import { StoryMute } from './storyMute.model';
import { expireStoriesOnce } from './story.service';
import { Attachment } from '../media/attachment.model';
import { ATTACHMENT_STATUS } from '../media/media.types';
import {
  realtimeEvents,
  type RealtimeEventName
} from '../../services/realtimeEvents';
import {
  STORY_MAX_ACTIVE_PER_USER,
  STORY_TEXT_MAX_LENGTH
} from './story.types';

const app = buildApp();

const PASSWORD = 'correct horse battery';

const createUser = async (overrides: {
  email: string;
  displayName: string;
  role?: Role;
}) => {
  const hash = await argon2.hash(PASSWORD);
  return User.create({
    email: overrides.email,
    passwordHash: hash,
    displayName: overrides.displayName,
    role: overrides.role ?? ROLES.MEMBER
  });
};

const login = async (email: string): Promise<string> => {
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ email, password: PASSWORD });
  return res.body.data.tokens.accessToken as string;
};

interface SeededUser {
  id: string;
  email: string;
  token: string;
}

const seedUser = async (
  email: string,
  displayName: string,
  role?: Role
): Promise<SeededUser> => {
  const user = await createUser({ email, displayName, role });
  const token = await login(email);
  return { id: user._id.toString(), email, token };
};

const seedUploadedAttachment = async (
  actor: SeededUser,
  overrides: Partial<{
    filename: string;
    mimeType: string;
    sizeBytes: number;
  }> = {}
): Promise<string> => {
  const issue = await request(app)
    .post('/api/v1/media/upload-url')
    .set('Authorization', `Bearer ${actor.token}`)
    .send({
      filename: overrides.filename ?? 'photo.png',
      mimeType: overrides.mimeType ?? 'image/png',
      sizeBytes: overrides.sizeBytes ?? 12_345
    });
  expect(issue.status).toBe(201);
  const id = issue.body.data.attachment.id as string;
  const completion = await request(app)
    .post('/api/v1/media/complete')
    .set('Authorization', `Bearer ${actor.token}`)
    .send({ attachmentId: id });
  expect(completion.status).toBe(200);
  return id;
};

const createStory = (
  actor: SeededUser,
  body: Record<string, unknown> = {}
) =>
  request(app)
    .post('/api/v1/stories')
    .set('Authorization', `Bearer ${actor.token}`)
    .send({ text: 'hello', ...body });

const listStories = (
  actor: SeededUser,
  query: Record<string, string | number | boolean> = {}
) => {
  const qs = new URLSearchParams(
    Object.fromEntries(
      Object.entries(query).map(([k, v]) => [k, String(v)])
    )
  ).toString();
  return request(app)
    .get(`/api/v1/stories${qs ? `?${qs}` : ''}`)
    .set('Authorization', `Bearer ${actor.token}`);
};

const getStory = (actor: SeededUser, storyId: string) =>
  request(app)
    .get(`/api/v1/stories/${storyId}`)
    .set('Authorization', `Bearer ${actor.token}`);

const viewStory = (actor: SeededUser, storyId: string) =>
  request(app)
    .post(`/api/v1/stories/${storyId}/view`)
    .set('Authorization', `Bearer ${actor.token}`);

const listViewers = (actor: SeededUser, storyId: string) =>
  request(app)
    .get(`/api/v1/stories/${storyId}/viewers`)
    .set('Authorization', `Bearer ${actor.token}`);

const deleteStory = (actor: SeededUser, storyId: string) =>
  request(app)
    .delete(`/api/v1/stories/${storyId}`)
    .set('Authorization', `Bearer ${actor.token}`);

beforeAll(async () => {
  await startTestDb();
});

afterAll(async () => {
  await stopTestDb();
});

afterEach(async () => {
  await clearTestDb();
  realtimeEvents.removeAllListeners();
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

describe('POST /api/v1/stories', () => {
  it('rejects unauthenticated callers', async () => {
    const res = await request(app)
      .post('/api/v1/stories')
      .send({ text: 'hi' });
    expect(res.status).toBe(401);
  });

  it('creates a text-only story with a default 24h expiry', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');

    const res = await createStory(alice, { text: 'hello world' });
    expect(res.status).toBe(201);
    expect(res.body.data.story.text).toBe('hello world');
    expect(res.body.data.story.authorId).toBe(alice.id);
    expect(res.body.data.story.audienceType).toBe('contacts');
    expect(res.body.data.story.viewerIsAuthor).toBe(true);
    // Expiry is ~24h ahead.
    const expiresMs = new Date(res.body.data.story.expiresAt).getTime();
    const expectedMs = Date.now() + 24 * 60 * 60 * 1000;
    expect(Math.abs(expiresMs - expectedMs)).toBeLessThan(5_000);
  });

  it('rejects empty content (no text, no media)', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await createStory(alice, { text: '' });
    expect(res.status).toBe(400);
  });

  it('rejects text longer than the cap', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const oversized = 'a'.repeat(STORY_TEXT_MAX_LENGTH + 1);
    const res = await createStory(alice, { text: oversized });
    expect(res.status).toBe(400);
  });

  it('rejects unknown body fields (mass-assignment guard)', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await request(app)
      .post('/api/v1/stories')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ text: 'hi', authorId: 'evil', deletedAt: new Date() });
    expect(res.status).toBe(400);
  });

  it('attaches uploaded media owned by the author', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const attachmentId = await seedUploadedAttachment(alice);

    const res = await createStory(alice, {
      text: 'photo time',
      mediaAttachmentIds: [attachmentId]
    });
    expect(res.status).toBe(201);
    expect(res.body.data.story.media).toHaveLength(1);
    expect(res.body.data.story.media[0].attachmentId).toBe(attachmentId);
    // Author gets a download URL (story owner is always authorized).
    expect(res.body.data.story.media[0].downloadUrl).toBeTruthy();
  });

  it('rejects media owned by a different user', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const bobsAttachment = await seedUploadedAttachment(bob);

    const res = await createStory(alice, {
      text: 'sneaky',
      mediaAttachmentIds: [bobsAttachment]
    });
    expect(res.status).toBe(403);
  });

  it('rejects media that is not in uploaded status', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    // A pending attachment (upload-url issued but never completed) is not
    // ready to be referenced.
    const pending = await request(app)
      .post('/api/v1/media/upload-url')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({
        filename: 'pending.png',
        mimeType: 'image/png',
        sizeBytes: 100
      });
    const res = await createStory(alice, {
      text: 'using pending',
      mediaAttachmentIds: [pending.body.data.attachment.id]
    });
    expect(res.status).toBe(400);
  });

  it('enforces the active-story per-user cap', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    // Insert STORY_MAX_ACTIVE_PER_USER active stories directly so we can
    // verify the cap without making STORY_MAX_ACTIVE_PER_USER API calls.
    const docs = Array.from({ length: STORY_MAX_ACTIVE_PER_USER }).map(() => ({
      authorId: new mongoose.Types.ObjectId(alice.id),
      text: 'filler',
      audienceType: 'everyone' as const,
      mediaAttachmentIds: [],
      selectedUserIds: [],
      excludedUserIds: [],
      expiresAt: new Date(Date.now() + 60 * 60 * 1000)
    }));
    await Story.insertMany(docs);

    const res = await createStory(alice, { text: 'one too many' });
    expect(res.status).toBe(400);
  });

  it('validates audienceType=selected requires selectedUserIds', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await createStory(alice, {
      text: 'private',
      audienceType: 'selected'
    });
    expect(res.status).toBe(400);
  });

  it('validates audienceType=except requires excludedUserIds', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await createStory(alice, {
      text: 'mostly public',
      audienceType: 'except'
    });
    expect(res.status).toBe(400);
  });

  it('emits story.created on the realtime bus', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const events: Array<{ event: RealtimeEventName; payload: unknown }> = [];
    realtimeEvents.on('story.created', (payload) =>
      events.push({ event: 'story.created', payload })
    );

    const res = await createStory(alice, {
      text: 'broadcast',
      audienceType: 'everyone'
    });
    expect(res.status).toBe(201);
    expect(events).toHaveLength(1);
    const payload = events[0].payload as {
      authorId: string;
      viewerIds: string[];
    };
    expect(payload.authorId).toBe(alice.id);
    expect(payload.viewerIds).toContain(bob.id);
  });
});

// ---------------------------------------------------------------------------
// Audience visibility
// ---------------------------------------------------------------------------

describe('Audience and visibility', () => {
  it('audienceType=everyone is visible to other users', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const created = await createStory(alice, {
      text: 'public',
      audienceType: 'everyone'
    });
    expect(created.status).toBe(201);

    const list = await listStories(bob);
    expect(list.status).toBe(200);
    expect(list.body.data.items).toHaveLength(1);
    expect(list.body.data.items[0].id).toBe(created.body.data.story.id);
    expect(list.body.data.items[0].viewerIsAuthor).toBe(false);
  });

  it('audienceType=selected hides the story from non-selected users', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const carol = await seedUser('carol@example.com', 'Carol');

    const created = await createStory(alice, {
      text: 'for bob only',
      audienceType: 'selected',
      selectedUserIds: [bob.id]
    });
    expect(created.status).toBe(201);

    const bobList = await listStories(bob);
    expect(bobList.body.data.items).toHaveLength(1);

    const carolList = await listStories(carol);
    expect(carolList.body.data.items).toHaveLength(0);

    // Direct fetch by id also hidden behind 404 to avoid existence probing.
    const carolDirect = await getStory(carol, created.body.data.story.id);
    expect(carolDirect.status).toBe(404);
  });

  it('audienceType=except hides the story from excluded users only', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const carol = await seedUser('carol@example.com', 'Carol');

    const created = await createStory(alice, {
      text: 'not for bob',
      audienceType: 'except',
      excludedUserIds: [bob.id]
    });

    const bobList = await listStories(bob);
    expect(bobList.body.data.items).toHaveLength(0);

    const carolList = await listStories(carol);
    expect(carolList.body.data.items).toHaveLength(1);
    expect(carolList.body.data.items[0].id).toBe(created.body.data.story.id);
  });

  it('expired stories are filtered out of listings and 404 on detail', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    // Insert a story with an expiry already in the past.
    const stale = await Story.create({
      authorId: new mongoose.Types.ObjectId(alice.id),
      text: 'old',
      mediaAttachmentIds: [],
      audienceType: 'everyone',
      selectedUserIds: [],
      excludedUserIds: [],
      expiresAt: new Date(Date.now() - 60_000)
    });

    const list = await listStories(bob);
    expect(list.body.data.items).toHaveLength(0);

    const detail = await getStory(bob, stale._id.toString());
    expect(detail.status).toBe(404);
  });

  it('non-owner cannot see selectedUserIds in the DTO', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const created = await createStory(alice, {
      text: 'for bob',
      audienceType: 'selected',
      selectedUserIds: [bob.id]
    });

    const bobDetail = await getStory(bob, created.body.data.story.id);
    expect(bobDetail.status).toBe(200);
    expect(bobDetail.body.data.story.selectedUserIds).toBeUndefined();
    expect(bobDetail.body.data.story.viewerCount).toBeUndefined();

    const aliceDetail = await getStory(alice, created.body.data.story.id);
    expect(aliceDetail.status).toBe(200);
    expect(aliceDetail.body.data.story.selectedUserIds).toEqual([bob.id]);
    expect(aliceDetail.body.data.story.viewerCount).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// View tracking
// ---------------------------------------------------------------------------

describe('POST /api/v1/stories/:id/view', () => {
  it('records a view and is idempotent for the same viewer', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const created = await createStory(alice, {
      text: 'view me',
      audienceType: 'everyone'
    });
    const storyId = created.body.data.story.id;

    const first = await viewStory(bob, storyId);
    expect(first.status).toBe(200);
    expect(first.body.data.viewedAt).toBeTruthy();

    const second = await viewStory(bob, storyId);
    expect(second.status).toBe(200);

    const viewDocs = await StoryView.find({});
    expect(viewDocs).toHaveLength(1);
  });

  it('owner self-view does not pollute viewer list', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const created = await createStory(alice, {
      text: 'mine',
      audienceType: 'everyone'
    });
    const res = await viewStory(alice, created.body.data.story.id);
    expect(res.status).toBe(200);

    const viewDocs = await StoryView.find({});
    expect(viewDocs).toHaveLength(0);
  });

  it('non-authorized viewer cannot mark viewed (404)', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const carol = await seedUser('carol@example.com', 'Carol');

    const created = await createStory(alice, {
      text: 'for bob only',
      audienceType: 'selected',
      selectedUserIds: [bob.id]
    });
    const res = await viewStory(carol, created.body.data.story.id);
    expect(res.status).toBe(404);
  });

  it('emits story.viewed on the realtime bus', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const created = await createStory(alice, {
      text: 'broadcast',
      audienceType: 'everyone'
    });

    const events: unknown[] = [];
    realtimeEvents.on('story.viewed', (p) => events.push(p));

    await viewStory(bob, created.body.data.story.id);
    expect(events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Viewer list
// ---------------------------------------------------------------------------

describe('GET /api/v1/stories/:id/viewers', () => {
  it('owner can list viewers', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const carol = await seedUser('carol@example.com', 'Carol');

    const created = await createStory(alice, {
      text: 'view me',
      audienceType: 'everyone'
    });
    await viewStory(bob, created.body.data.story.id);
    await viewStory(carol, created.body.data.story.id);

    const res = await listViewers(alice, created.body.data.story.id);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(2);
    const viewerIds = res.body.data.items.map(
      (item: { viewerId: string }) => item.viewerId
    );
    expect(viewerIds).toEqual(expect.arrayContaining([bob.id, carol.id]));
  });

  it('non-owner cannot list viewers (403)', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const created = await createStory(alice, {
      text: 'view me',
      audienceType: 'everyone'
    });
    await viewStory(bob, created.body.data.story.id);

    const res = await listViewers(bob, created.body.data.story.id);
    expect(res.status).toBe(403);
  });

  it('platform moderator cannot list viewers (privacy artifact, not moderation)', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const mod = await seedUser('mod@example.com', 'Mod', ROLES.MODERATOR);

    const created = await createStory(alice, {
      text: 'view me',
      audienceType: 'everyone'
    });
    await viewStory(bob, created.body.data.story.id);

    const res = await listViewers(mod, created.body.data.story.id);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Delete & moderator removal
// ---------------------------------------------------------------------------

describe('DELETE /api/v1/stories/:id', () => {
  it('owner can delete their own story', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const created = await createStory(alice, {
      text: 'oops',
      audienceType: 'everyone'
    });
    const res = await deleteStory(alice, created.body.data.story.id);
    expect(res.status).toBe(200);
    expect(res.body.data.story.deletedAt).toBeTruthy();
    expect(res.body.data.story.deletionReason).toBe('user_deleted');

    // Story is now hidden from everyone, including the owner.
    const detail = await getStory(alice, created.body.data.story.id);
    expect(detail.status).toBe(404);
  });

  it('non-owner without moderator permission cannot delete (403)', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const created = await createStory(alice, {
      text: 'theirs',
      audienceType: 'everyone'
    });
    const res = await deleteStory(bob, created.body.data.story.id);
    expect(res.status).toBe(403);
  });

  it('moderator with story:moderate can remove and reason is recorded', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const mod = await seedUser('mod@example.com', 'Mod', ROLES.MODERATOR);
    const created = await createStory(alice, {
      text: 'inappropriate',
      audienceType: 'everyone'
    });
    const res = await deleteStory(mod, created.body.data.story.id);
    expect(res.status).toBe(200);
    expect(res.body.data.story.deletionReason).toBe('moderator_removed');
  });

  it('delete is idempotent — second call returns redacted DTO, not 404', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const created = await createStory(alice, {
      text: 'one',
      audienceType: 'everyone'
    });
    await deleteStory(alice, created.body.data.story.id);
    const second = await deleteStory(alice, created.body.data.story.id);
    expect(second.status).toBe(200);
    expect(second.body.data.story.deletedAt).toBeTruthy();
  });

  it('soft-deletes story-owned media attachments', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const attachmentId = await seedUploadedAttachment(alice);

    const created = await createStory(alice, {
      text: 'photo',
      mediaAttachmentIds: [attachmentId],
      audienceType: 'everyone'
    });
    await deleteStory(alice, created.body.data.story.id);

    const att = await Attachment.findById(attachmentId);
    expect(att?.status).toBe(ATTACHMENT_STATUS.DELETED);
  });
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

describe('POST /api/v1/stories/:id/report', () => {
  it('member can report a visible story', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const created = await createStory(alice, {
      text: 'foo',
      audienceType: 'everyone'
    });
    const res = await request(app)
      .post(`/api/v1/stories/${created.body.data.story.id}/report`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ reason: 'harassment', details: 'context' });
    expect(res.status).toBe(200);
    expect(res.body.data.acknowledged).toBe(true);
  });

  it('cannot report your own story', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const created = await createStory(alice, {
      text: 'mine',
      audienceType: 'everyone'
    });
    const res = await request(app)
      .post(`/api/v1/stories/${created.body.data.story.id}/report`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ reason: 'spam' });
    expect(res.status).toBe(400);
  });

  it('rejects unknown report reasons', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const created = await createStory(alice, {
      text: 'foo',
      audienceType: 'everyone'
    });
    const res = await request(app)
      .post(`/api/v1/stories/${created.body.data.story.id}/report`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ reason: 'inscrutable' });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Mutes
// ---------------------------------------------------------------------------

describe('Mutes', () => {
  it('muted authors are hidden from the listing feed', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    await createStory(alice, {
      text: 'public',
      audienceType: 'everyone'
    });

    const muted = await request(app)
      .post('/api/v1/stories/mutes')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ mutedUserId: alice.id });
    expect(muted.status).toBe(201);

    const list = await listStories(bob);
    expect(list.body.data.items).toHaveLength(0);

    // Unmute — story returns.
    const unmuted = await request(app)
      .delete(`/api/v1/stories/mutes/${alice.id}`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(unmuted.status).toBe(200);

    const list2 = await listStories(bob);
    expect(list2.body.data.items).toHaveLength(1);
  });

  it('mute is idempotent and never lets you mute yourself', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');

    const self = await request(app)
      .post('/api/v1/stories/mutes')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ mutedUserId: alice.id });
    expect(self.status).toBe(400);

    const first = await request(app)
      .post('/api/v1/stories/mutes')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ mutedUserId: bob.id });
    const second = await request(app)
      .post('/api/v1/stories/mutes')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ mutedUserId: bob.id });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const docs = await StoryMute.find({});
    expect(docs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Expiration job
// ---------------------------------------------------------------------------

describe('expireStoriesOnce', () => {
  it('soft-deletes stories past expiry and is idempotent across runs', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    await Story.create({
      authorId: new mongoose.Types.ObjectId(alice.id),
      text: 'old',
      mediaAttachmentIds: [],
      audienceType: 'everyone',
      selectedUserIds: [],
      excludedUserIds: [],
      expiresAt: new Date(Date.now() - 60_000)
    });

    const first = await expireStoriesOnce();
    expect(first.expired).toBe(1);

    const after = await Story.find({});
    expect(after[0].deletedAt).toBeInstanceOf(Date);
    expect(after[0].deletionReason).toBe('expired');

    const second = await expireStoriesOnce();
    expect(second.expired).toBe(0);
  });

  it('leaves fresh stories alone', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    await Story.create({
      authorId: new mongoose.Types.ObjectId(alice.id),
      text: 'fresh',
      mediaAttachmentIds: [],
      audienceType: 'everyone',
      selectedUserIds: [],
      excludedUserIds: [],
      expiresAt: new Date(Date.now() + 60 * 60 * 1000)
    });
    const result = await expireStoriesOnce();
    expect(result.expired).toBe(0);
  });

  it('soft-deletes media attachments owned by expired stories', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const attachmentId = await seedUploadedAttachment(alice);

    await Story.create({
      authorId: new mongoose.Types.ObjectId(alice.id),
      text: 'with media',
      mediaAttachmentIds: [new mongoose.Types.ObjectId(attachmentId)],
      audienceType: 'everyone',
      selectedUserIds: [],
      excludedUserIds: [],
      expiresAt: new Date(Date.now() - 60_000)
    });

    await expireStoriesOnce();
    const att = await Attachment.findById(attachmentId);
    expect(att?.status).toBe(ATTACHMENT_STATUS.DELETED);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('Validation', () => {
  it('rejects malformed story id on detail', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await getStory(alice, 'not-an-id');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects out-of-range limit on list', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await listStories(alice, { limit: 9999 });
    expect(res.status).toBe(400);
  });
});
