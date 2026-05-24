import request from 'supertest';
import argon2 from 'argon2';
import mongoose from 'mongoose';
import { buildApp } from '../../app';
import { clearTestDb, startTestDb, stopTestDb } from '../../tests/db';
import { User } from '../users/user.model';
import { ROLES, type Role } from '../permissions/permissions.constants';
import { Attachment } from './attachment.model';
import { ATTACHMENT_STATUS } from './media.types';
import { cleanupOrphanedAttachments } from './media.service';

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

const createGroup = async (
  owner: SeededUser,
  memberIds: string[],
  title = 'Team'
) => {
  const res = await request(app)
    .post('/api/v1/conversations/groups')
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ title, memberIds });
  return res.body.data.conversation.id as string;
};

const requestUploadUrl = (
  actor: SeededUser,
  body: Record<string, unknown>
) =>
  request(app)
    .post('/api/v1/media/upload-url')
    .set('Authorization', `Bearer ${actor.token}`)
    .send(body);

const completeUpload = (
  actor: SeededUser,
  body: Record<string, unknown>
) =>
  request(app)
    .post('/api/v1/media/complete')
    .set('Authorization', `Bearer ${actor.token}`)
    .send(body);

const getAttachment = (actor: SeededUser, attachmentId: string) =>
  request(app)
    .get(`/api/v1/media/${attachmentId}`)
    .set('Authorization', `Bearer ${actor.token}`);

const deleteAttachment = (actor: SeededUser, attachmentId: string) =>
  request(app)
    .delete(`/api/v1/media/${attachmentId}`)
    .set('Authorization', `Bearer ${actor.token}`);

// Helper: issue + complete in one go, returning the attachment id. Used by
// the integration tests that focus on the attach-to-message path.
const seedUploadedAttachment = async (
  actor: SeededUser,
  overrides: Partial<{ filename: string; mimeType: string; sizeBytes: number }> = {}
): Promise<string> => {
  const issue = await requestUploadUrl(actor, {
    filename: overrides.filename ?? 'photo.png',
    mimeType: overrides.mimeType ?? 'image/png',
    sizeBytes: overrides.sizeBytes ?? 12_345
  });
  expect(issue.status).toBe(201);
  const id = issue.body.data.attachment.id as string;
  const completion = await completeUpload(actor, { attachmentId: id });
  expect(completion.status).toBe(200);
  return id;
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

describe('POST /api/v1/media/upload-url', () => {
  it('rejects unauthenticated callers', async () => {
    const res = await request(app)
      .post('/api/v1/media/upload-url')
      .send({ filename: 'a.png', mimeType: 'image/png', sizeBytes: 100 });
    expect(res.status).toBe(401);
  });

  it('issues a signed URL and creates a pending attachment', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await requestUploadUrl(alice, {
      filename: 'cat.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 50_000
    });
    expect(res.status).toBe(201);

    const { attachment, upload } = res.body.data;
    expect(attachment.status).toBe(ATTACHMENT_STATUS.PENDING);
    expect(attachment.ownerId).toBe(alice.id);
    expect(attachment.storageProvider).toBe('memory');
    // Server-generated storage key must not contain the original filename
    // (sanitization / non-trust check).
    expect(attachment.storageKey).not.toContain('cat.jpg');
    expect(upload.url).toMatch(/^https?:\/\//);
    expect(upload.method).toBe('PUT');
    expect(upload.headers['Content-Type']).toBe('image/jpeg');
    expect(new Date(upload.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(upload.maxBytes).toBeGreaterThan(0);

    const stored = await Attachment.findById(attachment.id);
    expect(stored?.status).toBe(ATTACHMENT_STATUS.PENDING);
  });

  it('rejects blocked / executable MIME types', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await requestUploadUrl(alice, {
      filename: 'evil.png',
      mimeType: 'application/x-msdownload',
      sizeBytes: 100
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects executable extensions even when the MIME claims something safe', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await requestUploadUrl(alice, {
      filename: 'payload.exe',
      mimeType: 'image/png',
      sizeBytes: 100
    });
    expect(res.status).toBe(400);
  });

  it('rejects files exceeding the size limit', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await requestUploadUrl(alice, {
      filename: 'huge.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 999_999_999_999
    });
    expect(res.status).toBe(400);
  });

  it('rejects filenames without an extension', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await requestUploadUrl(alice, {
      filename: 'noextension',
      mimeType: 'image/png',
      sizeBytes: 100
    });
    expect(res.status).toBe(400);
  });

  it('rejects unknown fields (mass-assignment guard)', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await requestUploadUrl(alice, {
      filename: 'a.png',
      mimeType: 'image/png',
      sizeBytes: 100,
      ownerId: new mongoose.Types.ObjectId().toString()
    });
    expect(res.status).toBe(400);
  });

  it('sanitizes path-traversal style filenames', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await requestUploadUrl(alice, {
      filename: '../../etc/passwd.png',
      mimeType: 'image/png',
      sizeBytes: 100
    });
    expect(res.status).toBe(201);
    expect(res.body.data.attachment.originalFilename).not.toContain('/');
    expect(res.body.data.attachment.originalFilename).not.toContain('..');
  });
});

describe('POST /api/v1/media/complete', () => {
  it('only the owner can complete their attachment', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const issue = await requestUploadUrl(alice, {
      filename: 'cat.png',
      mimeType: 'image/png',
      sizeBytes: 100
    });
    const id = issue.body.data.attachment.id as string;
    const res = await completeUpload(bob, { attachmentId: id });
    expect(res.status).toBe(404);
  });

  it('transitions PENDING → UPLOADED and surfaces final metadata', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const issue = await requestUploadUrl(alice, {
      filename: 'cat.png',
      mimeType: 'image/png',
      sizeBytes: 100
    });
    const id = issue.body.data.attachment.id as string;
    const res = await completeUpload(alice, {
      attachmentId: id,
      sizeBytes: 12_345,
      width: 800,
      height: 600,
      checksumSha256: 'a'.repeat(64)
    });
    expect(res.status).toBe(200);
    expect(res.body.data.attachment.status).toBe(ATTACHMENT_STATUS.UPLOADED);
    expect(res.body.data.attachment.sizeBytes).toBe(12_345);
    expect(res.body.data.attachment.width).toBe(800);
    expect(res.body.data.attachment.checksumSha256).toBe('a'.repeat(64));
  });

  it('rejects double-complete', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const id = await seedUploadedAttachment(alice);
    const res = await completeUpload(alice, { attachmentId: id });
    expect(res.status).toBe(400);
  });

  it('rejects a reported size beyond MEDIA_MAX_BYTES and marks rejected', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const issue = await requestUploadUrl(alice, {
      filename: 'cat.png',
      mimeType: 'image/png',
      sizeBytes: 100
    });
    const id = issue.body.data.attachment.id as string;
    const res = await completeUpload(alice, {
      attachmentId: id,
      sizeBytes: 999_999_999_999
    });
    expect(res.status).toBe(400);
    const stored = await Attachment.findById(id);
    expect(stored?.status).toBe(ATTACHMENT_STATUS.REJECTED);
  });
});

describe('GET /api/v1/media/:id', () => {
  it('owner can read an UPLOADED attachment they have not attached yet', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const id = await seedUploadedAttachment(alice);
    const res = await getAttachment(alice, id);
    expect(res.status).toBe(200);
    expect(res.body.data.attachment.id).toBe(id);
    expect(res.body.data.download.url).toMatch(/^https?:\/\//);
    expect(new Date(res.body.data.download.expiresAt).getTime()).toBeGreaterThan(
      Date.now()
    );
  });

  it('non-owner cannot read a PENDING/UPLOADED attachment', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const id = await seedUploadedAttachment(alice);
    const res = await getAttachment(bob, id);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a non-existent attachment id', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await getAttachment(alice, new mongoose.Types.ObjectId().toString());
    expect(res.status).toBe(404);
  });

  it('rejects malformed attachment ids', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const res = await getAttachment(alice, 'not-an-id');
    expect(res.status).toBe(400);
  });

  it('a conversation member CAN read an ATTACHED attachment from that conversation', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(alice, [bob.id]);
    const attachmentId = await seedUploadedAttachment(alice);
    const send = await request(app)
      .post(`/api/v1/conversations/${convId}/messages`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ text: 'check this', attachmentIds: [attachmentId] });
    expect(send.status).toBe(201);

    const res = await getAttachment(bob, attachmentId);
    expect(res.status).toBe(200);
  });

  it('a non-member CANNOT read an ATTACHED attachment', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const eve = await seedUser('eve@example.com', 'Eve');
    const convId = await createGroup(alice, [bob.id]);
    const attachmentId = await seedUploadedAttachment(alice);
    await request(app)
      .post(`/api/v1/conversations/${convId}/messages`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ text: 'private', attachmentIds: [attachmentId] });

    const res = await getAttachment(eve, attachmentId);
    expect(res.status).toBe(403);
  });

  it('deleted attachments return 404 even for the owner', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const id = await seedUploadedAttachment(alice);
    await deleteAttachment(alice, id);
    const res = await getAttachment(alice, id);
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/v1/media/:id', () => {
  it('owner can soft-delete their own attachment', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const id = await seedUploadedAttachment(alice);
    const res = await deleteAttachment(alice, id);
    expect(res.status).toBe(200);
    expect(res.body.data.attachment.status).toBe(ATTACHMENT_STATUS.DELETED);

    const stored = await Attachment.findById(id);
    expect(stored?.status).toBe(ATTACHMENT_STATUS.DELETED);
    expect(stored?.deletedAt).toBeInstanceOf(Date);
    expect(stored?.deletedBy?.toString()).toBe(alice.id);
  });

  it('non-owner cannot delete', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const id = await seedUploadedAttachment(alice);
    const res = await deleteAttachment(bob, id);
    expect(res.status).toBe(403);
  });

  it('moderator can delete other users attachments', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const mod = await seedUser('mod@example.com', 'Mod', ROLES.MODERATOR);
    const id = await seedUploadedAttachment(alice);
    const res = await deleteAttachment(mod, id);
    expect(res.status).toBe(200);
  });

  it('delete is idempotent', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const id = await seedUploadedAttachment(alice);
    const first = await deleteAttachment(alice, id);
    expect(first.status).toBe(200);
    const second = await deleteAttachment(alice, id);
    expect(second.status).toBe(200);
    expect(second.body.data.attachment.status).toBe(ATTACHMENT_STATUS.DELETED);
  });
});

describe('Attaching to messages', () => {
  it('allows a member to attach their uploaded attachment to a conversation they belong to', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(alice, [bob.id]);
    const attachmentId = await seedUploadedAttachment(alice);

    const res = await request(app)
      .post(`/api/v1/conversations/${convId}/messages`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ text: 'with media', attachmentIds: [attachmentId] });
    expect(res.status).toBe(201);
    expect(res.body.data.message.attachments).toHaveLength(1);
    expect(res.body.data.message.attachments[0].id).toBe(attachmentId);

    const stored = await Attachment.findById(attachmentId);
    expect(stored?.status).toBe(ATTACHMENT_STATUS.ATTACHED);
    expect(stored?.conversationId?.toString()).toBe(convId);
    expect(stored?.messageId?.toString()).toBe(res.body.data.message.id);
  });

  it('rejects attaching someone else’s attachment', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(alice, [bob.id]);
    const attachmentId = await seedUploadedAttachment(alice);

    const res = await request(app)
      .post(`/api/v1/conversations/${convId}/messages`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ text: 'theft', attachmentIds: [attachmentId] });
    expect(res.status).toBe(403);

    const stored = await Attachment.findById(attachmentId);
    expect(stored?.status).toBe(ATTACHMENT_STATUS.UPLOADED);
    expect(stored?.messageId).toBeUndefined();
  });

  it('rejects attaching an attachment to a conversation the sender is not a member of', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const eve = await seedUser('eve@example.com', 'Eve');
    const convId = await createGroup(alice, [bob.id]);
    const attachmentId = await seedUploadedAttachment(eve);

    const res = await request(app)
      .post(`/api/v1/conversations/${convId}/messages`)
      .set('Authorization', `Bearer ${eve.token}`)
      .send({ text: 'sneak', attachmentIds: [attachmentId] });
    expect(res.status).toBe(404);

    const stored = await Attachment.findById(attachmentId);
    expect(stored?.status).toBe(ATTACHMENT_STATUS.UPLOADED);
  });

  it('rejects reusing an already-attached attachment in a second message', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(alice, [bob.id]);
    const attachmentId = await seedUploadedAttachment(alice);

    const first = await request(app)
      .post(`/api/v1/conversations/${convId}/messages`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ text: 'first', attachmentIds: [attachmentId] });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/v1/conversations/${convId}/messages`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ text: 'second', attachmentIds: [attachmentId] });
    expect(second.status).toBe(400);
  });

  it('rejects attaching a PENDING attachment that was never completed', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(alice, [bob.id]);

    const issue = await requestUploadUrl(alice, {
      filename: 'pending.png',
      mimeType: 'image/png',
      sizeBytes: 100
    });
    const attachmentId = issue.body.data.attachment.id as string;

    const res = await request(app)
      .post(`/api/v1/conversations/${convId}/messages`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ text: 'too early', attachmentIds: [attachmentId] });
    expect(res.status).toBe(400);
  });

  it('rejects duplicate attachment ids in the same message', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(alice, [bob.id]);
    const attachmentId = await seedUploadedAttachment(alice);

    const res = await request(app)
      .post(`/api/v1/conversations/${convId}/messages`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({
        text: 'dup',
        attachmentIds: [attachmentId, attachmentId]
      });
    expect(res.status).toBe(400);
  });

  it('allows an attachment-only message (no text)', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(alice, [bob.id]);
    const attachmentId = await seedUploadedAttachment(alice);

    const res = await request(app)
      .post(`/api/v1/conversations/${convId}/messages`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ attachmentIds: [attachmentId] });
    expect(res.status).toBe(201);
    expect(res.body.data.message.attachments).toHaveLength(1);
  });

  it('still rejects an empty payload (no text, no attachments)', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(alice, [bob.id]);

    const res = await request(app)
      .post(`/api/v1/conversations/${convId}/messages`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('message GET / LIST include attachment summaries for the parent message', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(alice, [bob.id]);
    const attachmentId = await seedUploadedAttachment(alice);

    const send = await request(app)
      .post(`/api/v1/conversations/${convId}/messages`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ text: 'with media', attachmentIds: [attachmentId] });
    const messageId = send.body.data.message.id as string;

    const got = await request(app)
      .get(`/api/v1/messages/${messageId}`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(got.status).toBe(200);
    expect(got.body.data.message.attachments).toHaveLength(1);
    expect(got.body.data.message.attachments[0].mimeType).toBe('image/png');

    const list = await request(app)
      .get(`/api/v1/conversations/${convId}/messages`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(list.status).toBe(200);
    expect(list.body.data.items[0].attachments).toHaveLength(1);
  });

  it('deleting the parent message hides attachment summaries from clients', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com', 'Bob');
    const convId = await createGroup(alice, [bob.id]);
    const attachmentId = await seedUploadedAttachment(alice);

    const send = await request(app)
      .post(`/api/v1/conversations/${convId}/messages`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ text: 'oops', attachmentIds: [attachmentId] });
    const messageId = send.body.data.message.id as string;

    await request(app)
      .delete(`/api/v1/messages/${messageId}`)
      .set('Authorization', `Bearer ${alice.token}`);

    const got = await request(app)
      .get(`/api/v1/messages/${messageId}`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(got.status).toBe(200);
    expect(got.body.data.message.attachments).toBeUndefined();
    expect(got.body.data.message.text).toBeNull();
  });
});

describe('Orphan cleanup', () => {
  it('rejects pending attachments older than the TTL', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const fresh = await requestUploadUrl(alice, {
      filename: 'new.png',
      mimeType: 'image/png',
      sizeBytes: 100
    });
    const stale = await requestUploadUrl(alice, {
      filename: 'old.png',
      mimeType: 'image/png',
      sizeBytes: 100
    });
    const staleId = stale.body.data.attachment.id as string;

    // Backdate the stale one so the cleanup picks it up.
    // Bypass Mongoose to backdate createdAt (the schema treats it as
    // immutable, so updateOne on the model is a silent no-op).
    await Attachment.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(staleId) },
      { $set: { createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000) } }
    );

    const result = await cleanupOrphanedAttachments(new Date(), 60);
    expect(result.rejected).toBe(1);

    const staleDoc = await Attachment.findById(staleId);
    expect(staleDoc?.status).toBe(ATTACHMENT_STATUS.REJECTED);

    const freshId = fresh.body.data.attachment.id as string;
    const freshDoc = await Attachment.findById(freshId);
    expect(freshDoc?.status).toBe(ATTACHMENT_STATUS.PENDING);
  });

  it('does not touch UPLOADED or ATTACHED attachments', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const uploadedId = await seedUploadedAttachment(alice);
    await Attachment.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(uploadedId) },
      { $set: { createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000) } }
    );

    const result = await cleanupOrphanedAttachments(new Date(), 60);
    expect(result.rejected).toBe(0);

    const doc = await Attachment.findById(uploadedId);
    expect(doc?.status).toBe(ATTACHMENT_STATUS.UPLOADED);
  });
});
