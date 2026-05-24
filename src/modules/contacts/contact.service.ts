import mongoose, { type FilterQuery, type Types } from 'mongoose';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError
} from '../../utils/errors';
import { User } from '../users/user.model';
import { USER_STATUS } from '../users/user.types';
import type { AuthenticatedActor } from '../permissions/authorization';
import { isBlockedBetween } from '../moderation/block.service';
import { createNotification } from '../notifications/notification.service';
import {
  NOTIFICATION_ENTITY_TYPE,
  NOTIFICATION_TYPE
} from '../notifications/notification.types';
import {
  Contact,
  toContactDto,
  type ContactDocument
} from './contact.model';
import {
  ContactRequest,
  toContactRequestDto,
  type ContactRequestDocument
} from './contactRequest.model';
import {
  CONTACT_REQUEST_STATUS,
  type ContactDto,
  type ContactListItemDto,
  type ContactRequestDto,
  type ContactRequestListItemDto,
  type ContactUserSummaryDto
} from './contact.types';
import type {
  CreateContactRequestInput,
  ListContactRequestsQuery,
  ListContactsQuery
} from './contact.validation';

const toObjectId = (id: string): Types.ObjectId =>
  new mongoose.Types.ObjectId(id);

// Build the contact-list summary directly from the loaded user document.
// We intentionally hand-build the projection (rather than calling
// toPublicUserDto) so we can omit `createdAt` and `bio` — neither belongs in
// a contact list row.
const summarizeUser = (
  user: import('../users/user.model').UserDocument
): ContactUserSummaryDto => {
  const summary: ContactUserSummaryDto = {
    id: (user._id as Types.ObjectId).toString(),
    displayName: user.displayName
  };
  if (user.username) summary.username = user.username;
  if (user.avatarUrl) summary.avatarUrl = user.avatarUrl;
  return summary;
};

// Public helper: "is the given user a contact of the actor?". Used by other
// modules (privacy/search/messaging) so they don't have to know about the
// Contact collection shape.
export const isContactOf = async (
  actorUserId: string,
  otherUserId: string
): Promise<boolean> => {
  if (actorUserId === otherUserId) return false;
  const hit = await Contact.exists({
    userId: toObjectId(actorUserId),
    contactUserId: toObjectId(otherUserId)
  });
  return hit !== null;
};

// Symmetric variant: "are A and B mutually contacts?". Most product rules
// want symmetric semantics (you only count as someone's contact when they
// also count you). We persist two directed rows on accept, so the symmetric
// check is exactly "both rows exist".
export const areMutualContacts = async (
  userIdA: string,
  userIdB: string
): Promise<boolean> => {
  if (userIdA === userIdB) return false;
  const [aHasB, bHasA] = await Promise.all([
    isContactOf(userIdA, userIdB),
    isContactOf(userIdB, userIdA)
  ]);
  return aHasB && bHasA;
};

const ensureActiveUserExists = async (userId: string): Promise<void> => {
  const exists = await User.exists({
    _id: toObjectId(userId),
    status: USER_STATUS.ACTIVE
  });
  if (!exists) throw new NotFoundError('User not found');
};

// ---------------------------------------------------------------------------
// Requests: create / accept / decline / cancel
// ---------------------------------------------------------------------------

export const createContactRequest = async (
  actor: AuthenticatedActor,
  input: CreateContactRequestInput
): Promise<ContactRequestDto> => {
  if (input.receiverId === actor.id) {
    throw new BadRequestError('You cannot send a contact request to yourself');
  }

  await ensureActiveUserExists(input.receiverId);

  // Block rule — both directions kill request creation. We use the symmetric
  // helper because either side's block must sever the relationship: the
  // sender obviously can't contact someone who blocked them, and a user can't
  // request to add someone they themselves have blocked.
  if (await isBlockedBetween(actor.id, input.receiverId)) {
    throw new ForbiddenError('You cannot send a contact request to this user');
  }

  // Already mutual contacts — no point creating a new request.
  if (await areMutualContacts(actor.id, input.receiverId)) {
    throw new ConflictError('Already in contacts');
  }

  // If the receiver has already sent the actor a pending request, treat this
  // as an accept-by-mirror: the spec doesn't require it, but auto-accepting
  // prevents a duplicate pair of crossing requests. Simpler and safer to
  // surface a clear error and let the client navigate the user to "accept".
  const reverse = await ContactRequest.findOne({
    senderId: toObjectId(input.receiverId),
    receiverId: toObjectId(actor.id),
    status: CONTACT_REQUEST_STATUS.PENDING
  });
  if (reverse) {
    throw new ConflictError(
      'This user has already sent you a contact request — accept it instead'
    );
  }

  try {
    const doc = await ContactRequest.create({
      senderId: toObjectId(actor.id),
      receiverId: toObjectId(input.receiverId),
      status: CONTACT_REQUEST_STATUS.PENDING,
      ...(input.message ? { message: input.message } : {})
    });

    // Best-effort notification to the receiver. Failure must not roll the
    // request back — the inbox row is convenience metadata.
    const sender = await User.findById(actor.id).select('displayName');
    if (sender) {
      await createNotification({
        userId: input.receiverId,
        type: NOTIFICATION_TYPE.CONVERSATION_INVITE,
        title: `${sender.displayName} sent you a contact request`,
        entityType: NOTIFICATION_ENTITY_TYPE.USER,
        entityId: actor.id,
        data: { kind: 'contact_request', senderId: actor.id }
      }).catch(() => {
        /* swallowed; the request itself succeeded */
      });
    }

    return toContactRequestDto(doc);
  } catch (err) {
    if (err instanceof mongoose.mongo.MongoServerError && err.code === 11000) {
      throw new ConflictError('A pending request already exists');
    }
    throw err;
  }
};

// Resource-level guard for accept / decline / cancel. Returns the request
// document or throws — never returns null. The role parameter controls which
// side of the request the actor must be on for the action to be legal.
const fetchOwnedRequestOr404 = async (
  actor: AuthenticatedActor,
  requestId: string,
  role: 'sender' | 'receiver'
): Promise<ContactRequestDocument> => {
  const doc = await ContactRequest.findById(requestId);
  if (!doc) throw new NotFoundError('Contact request not found');
  const expectedField =
    role === 'sender' ? doc.senderId.toString() : doc.receiverId.toString();
  if (expectedField !== actor.id) {
    // 404 (not 403) — don't reveal that the request exists but belongs to
    // someone else. This is the same pattern used in the notifications and
    // moderation modules.
    throw new NotFoundError('Contact request not found');
  }
  return doc;
};

// Helper used by both accept and decline to refuse acting on a request that
// is no longer pending.
const requirePending = (doc: ContactRequestDocument): void => {
  if (doc.status !== CONTACT_REQUEST_STATUS.PENDING) {
    throw new ConflictError(
      `This request is already ${doc.status} and cannot be changed`
    );
  }
};

export const acceptContactRequest = async (
  actor: AuthenticatedActor,
  requestId: string
): Promise<{ request: ContactRequestDto; contact: ContactDto }> => {
  const doc = await fetchOwnedRequestOr404(actor, requestId, 'receiver');
  requirePending(doc);

  // Re-check blocks at accept time — the blocker may have appeared after the
  // request was sent.
  const senderId = doc.senderId.toString();
  if (await isBlockedBetween(actor.id, senderId)) {
    throw new ForbiddenError('You cannot accept this request');
  }

  doc.status = CONTACT_REQUEST_STATUS.ACCEPTED;
  doc.respondedAt = new Date();
  await doc.save();

  // Insert both directed contact rows. Use ordered: false + try/catch so a
  // pre-existing row (idempotent retry of accept) is treated as success.
  const rows = [
    { userId: toObjectId(actor.id), contactUserId: toObjectId(senderId) },
    { userId: toObjectId(senderId), contactUserId: toObjectId(actor.id) }
  ];
  try {
    await Contact.insertMany(rows, { ordered: false });
  } catch (err) {
    if (
      err instanceof mongoose.mongo.MongoBulkWriteError &&
      err.code !== 11000
    ) {
      throw err;
    }
    // Any 11000s here are benign — they just mean the row was already there.
  }

  const myRow = await Contact.findOne({
    userId: toObjectId(actor.id),
    contactUserId: toObjectId(senderId)
  });
  if (!myRow) {
    throw new ConflictError('Contact state is inconsistent');
  }

  // Notify the original sender that their request was accepted. Best-effort.
  const accepter = await User.findById(actor.id).select('displayName');
  if (accepter) {
    await createNotification({
      userId: senderId,
      type: NOTIFICATION_TYPE.CONVERSATION_INVITE,
      title: `${accepter.displayName} accepted your contact request`,
      entityType: NOTIFICATION_ENTITY_TYPE.USER,
      entityId: actor.id,
      data: { kind: 'contact_accepted', accepterId: actor.id }
    }).catch(() => {
      /* swallowed */
    });
  }

  return { request: toContactRequestDto(doc), contact: toContactDto(myRow) };
};

export const declineContactRequest = async (
  actor: AuthenticatedActor,
  requestId: string
): Promise<ContactRequestDto> => {
  const doc = await fetchOwnedRequestOr404(actor, requestId, 'receiver');
  requirePending(doc);

  doc.status = CONTACT_REQUEST_STATUS.DECLINED;
  doc.respondedAt = new Date();
  await doc.save();
  return toContactRequestDto(doc);
};

// Cancel: only the sender can cancel an outstanding outbound request.
export const cancelContactRequest = async (
  actor: AuthenticatedActor,
  requestId: string
): Promise<ContactRequestDto> => {
  const doc = await fetchOwnedRequestOr404(actor, requestId, 'sender');
  requirePending(doc);

  doc.status = CONTACT_REQUEST_STATUS.CANCELLED;
  doc.respondedAt = new Date();
  await doc.save();
  return toContactRequestDto(doc);
};

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

const loadUserSummaries = async (
  userIds: Types.ObjectId[]
): Promise<Map<string, ContactUserSummaryDto>> => {
  if (userIds.length === 0) return new Map();
  const users = await User.find({ _id: { $in: userIds } });
  const map = new Map<string, ContactUserSummaryDto>();
  for (const u of users) {
    map.set((u._id as Types.ObjectId).toString(), summarizeUser(u));
  }
  return map;
};

export const listMyContacts = async (
  actor: AuthenticatedActor,
  query: ListContactsQuery
): Promise<{ items: ContactListItemDto[]; nextCursor: string | null }> => {
  const filter: FilterQuery<ContactDocument> = {
    userId: toObjectId(actor.id)
  };
  if (query.cursor) {
    filter._id = { $lt: toObjectId(query.cursor) };
  }

  const docs = await Contact.find(filter)
    .sort({ _id: -1 })
    .limit(query.limit + 1);
  const hasMore = docs.length > query.limit;
  const page = hasMore ? docs.slice(0, query.limit) : docs;
  if (page.length === 0) return { items: [], nextCursor: null };

  const summaries = await loadUserSummaries(page.map((d) => d.contactUserId));

  const items: ContactListItemDto[] = [];
  for (const d of page) {
    const user = summaries.get(d.contactUserId.toString());
    if (!user) continue; // user record gone — skip the row
    items.push({ contact: toContactDto(d), user });
  }

  const lastId = page[page.length - 1]._id as Types.ObjectId;
  return {
    items,
    nextCursor: hasMore ? lastId.toString() : null
  };
};

const listRequests = async (
  actor: AuthenticatedActor,
  query: ListContactRequestsQuery,
  direction: 'incoming' | 'outgoing'
): Promise<{
  items: ContactRequestListItemDto[];
  nextCursor: string | null;
}> => {
  const filter: FilterQuery<ContactRequestDocument> = {
    status: CONTACT_REQUEST_STATUS.PENDING
  };
  if (direction === 'incoming') {
    filter.receiverId = toObjectId(actor.id);
  } else {
    filter.senderId = toObjectId(actor.id);
  }
  if (query.cursor) {
    filter._id = { $lt: toObjectId(query.cursor) };
  }

  const docs = await ContactRequest.find(filter)
    .sort({ _id: -1 })
    .limit(query.limit + 1);
  const hasMore = docs.length > query.limit;
  const page = hasMore ? docs.slice(0, query.limit) : docs;
  if (page.length === 0) return { items: [], nextCursor: null };

  // For incoming requests the "other side" is the sender; for outgoing it is
  // the receiver. Build the id list accordingly.
  const otherIds = page.map((d) =>
    direction === 'incoming' ? d.senderId : d.receiverId
  );
  const summaries = await loadUserSummaries(otherIds);

  const items: ContactRequestListItemDto[] = [];
  for (const d of page) {
    const otherId = (
      direction === 'incoming' ? d.senderId : d.receiverId
    ).toString();
    const user = summaries.get(otherId);
    if (!user) continue;
    items.push({ request: toContactRequestDto(d), user });
  }

  const lastId = page[page.length - 1]._id as Types.ObjectId;
  return {
    items,
    nextCursor: hasMore ? lastId.toString() : null
  };
};

export const listIncomingRequests = (
  actor: AuthenticatedActor,
  query: ListContactRequestsQuery
): Promise<{
  items: ContactRequestListItemDto[];
  nextCursor: string | null;
}> => listRequests(actor, query, 'incoming');

export const listOutgoingRequests = (
  actor: AuthenticatedActor,
  query: ListContactRequestsQuery
): Promise<{
  items: ContactRequestListItemDto[];
  nextCursor: string | null;
}> => listRequests(actor, query, 'outgoing');

// ---------------------------------------------------------------------------
// Remove contact
// ---------------------------------------------------------------------------

// Removing a contact drops BOTH directed rows so the other side stops seeing
// you as a contact too. The spec is mutual: contacts only count when both
// directed rows exist; leaving the other side's row behind would surface a
// half-broken state in privacy gates.
export const removeContact = async (
  actor: AuthenticatedActor,
  otherUserId: string
): Promise<void> => {
  if (otherUserId === actor.id) {
    throw new BadRequestError('Invalid contact');
  }
  const a = toObjectId(actor.id);
  const b = toObjectId(otherUserId);
  const res = await Contact.deleteMany({
    $or: [
      { userId: a, contactUserId: b },
      { userId: b, contactUserId: a }
    ]
  });
  if (res.deletedCount === 0) {
    throw new NotFoundError('Contact not found');
  }
};
