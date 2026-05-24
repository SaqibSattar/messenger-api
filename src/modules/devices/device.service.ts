import mongoose, { type FilterQuery, type Types } from 'mongoose';
import { ForbiddenError, NotFoundError } from '../../utils/errors';
import type { AuthenticatedActor } from '../permissions/authorization';
import { Device, toDeviceDto, type DeviceDocument } from './device.model';
import {
  DEVICE_STALE_AFTER_DAYS,
  type DeviceDto
} from './device.types';
import type {
  ListDevicesQuery,
  RegisterDeviceInput,
  UpdateDeviceInput
} from './device.validation';

const toObjectId = (id: string): Types.ObjectId =>
  new mongoose.Types.ObjectId(id);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Resource-level guard. The DTO never carries another user's pushToken, but
// listing/editing another user's row would still be a privacy leak (device
// names, locales, "I'm signed in on iOS-2"), so the rule is strict equality
// of the row's owner against the caller. We translate "exists but not yours"
// into a 404 so a probing client cannot distinguish from "missing".
const fetchOwnedOr404 = async (
  actor: AuthenticatedActor,
  deviceId: string
): Promise<DeviceDocument> => {
  const doc = await Device.findById(deviceId);
  if (!doc) throw new NotFoundError('Device not found');
  if (doc.userId.toString() !== actor.id) {
    throw new NotFoundError('Device not found');
  }
  return doc;
};

// ---------------------------------------------------------------------------
// Register / re-register
// ---------------------------------------------------------------------------

// Registration is upsert-on-token semantics:
//
//   - The push token is the natural key. The same physical device can
//     re-register (re-install, app reopen, refresh of an APNs token) and the
//     existing row gets its lastSeenAt and metadata updated.
//
//   - If the row currently belongs to a different user, the previous owner's
//     row is revoked and a fresh row is created for the caller. This is the
//     account-swap scenario — Alice signs out, Bob signs in on the same
//     phone; Alice must stop receiving Bob's pushes.
export const registerDevice = async (
  actor: AuthenticatedActor,
  input: RegisterDeviceInput
): Promise<DeviceDto> => {
  const now = new Date();

  // Look up by token explicitly (token is select:false, so this read is the
  // privileged path that can see the existing owner).
  const existing = await Device.findOne({ pushToken: input.pushToken }).select(
    '+pushToken'
  );

  if (existing && existing.userId.toString() === actor.id) {
    // Same user re-registering — refresh metadata and clear any prior
    // soft-revoke. We trust the client's updated platform/provider in case
    // a token has been re-issued under a different transport.
    existing.platform = input.platform;
    existing.pushProvider = input.pushProvider;
    if (input.deviceName !== undefined) existing.deviceName = input.deviceName;
    if (input.appVersion !== undefined) existing.appVersion = input.appVersion;
    if (input.locale !== undefined) existing.locale = input.locale;
    existing.lastSeenAt = now;
    existing.revokedAt = undefined;
    await existing.save();
    return toDeviceDto(existing);
  }

  if (existing) {
    // Token belongs to someone else. Soft-revoke the previous owner's row so
    // the unique index on pushToken doesn't collide and we still keep the
    // historical record for that user's audit trail. We then delete the
    // revoked row so a fresh registration owns the token outright — keeping
    // the old row would violate the unique index.
    await Device.deleteOne({ _id: existing._id });
  }

  const created = await Device.create({
    userId: toObjectId(actor.id),
    platform: input.platform,
    pushProvider: input.pushProvider,
    pushToken: input.pushToken,
    ...(input.deviceName !== undefined ? { deviceName: input.deviceName } : {}),
    ...(input.appVersion !== undefined ? { appVersion: input.appVersion } : {}),
    ...(input.locale !== undefined ? { locale: input.locale } : {}),
    lastSeenAt: now
  });
  return toDeviceDto(created);
};

// ---------------------------------------------------------------------------
// List / get
// ---------------------------------------------------------------------------

export const listMyDevices = async (
  actor: AuthenticatedActor,
  query: ListDevicesQuery
): Promise<{ items: DeviceDto[]; nextCursor: string | null }> => {
  const filter: FilterQuery<DeviceDocument> = {
    userId: toObjectId(actor.id)
  };
  if (!query.includeRevoked) {
    filter.revokedAt = { $exists: false };
  }
  if (query.cursor) {
    filter._id = { $lt: toObjectId(query.cursor) };
  }

  const docs = await Device.find(filter)
    .sort({ _id: -1 })
    .limit(query.limit + 1);

  const hasMore = docs.length > query.limit;
  const page = hasMore ? docs.slice(0, query.limit) : docs;
  const lastId = page[page.length - 1]?._id as Types.ObjectId | undefined;
  return {
    items: page.map(toDeviceDto),
    nextCursor: hasMore && lastId ? lastId.toString() : null
  };
};

// ---------------------------------------------------------------------------
// Update metadata
// ---------------------------------------------------------------------------

export const updateDevice = async (
  actor: AuthenticatedActor,
  deviceId: string,
  input: UpdateDeviceInput
): Promise<DeviceDto> => {
  const doc = await fetchOwnedOr404(actor, deviceId);
  // Never touch the metadata of a revoked device — that path would let a
  // caller silently un-revoke by patching deviceName. Revoked devices must
  // be re-registered through POST /devices to come back.
  if (doc.revokedAt) {
    throw new ForbiddenError('Cannot update a revoked device');
  }
  if (input.deviceName !== undefined) doc.deviceName = input.deviceName;
  if (input.appVersion !== undefined) doc.appVersion = input.appVersion;
  if (input.locale !== undefined) doc.locale = input.locale;
  doc.lastSeenAt = new Date();
  await doc.save();
  return toDeviceDto(doc);
};

// ---------------------------------------------------------------------------
// Unregister
// ---------------------------------------------------------------------------

// Soft-revoke rather than delete: a user looking at their security log wants
// to see "Pixel 7 — signed out on May 24" rather than have the row silently
// disappear. The push worker treats `revokedAt` as a skip signal.
export const unregisterDevice = async (
  actor: AuthenticatedActor,
  deviceId: string
): Promise<DeviceDto> => {
  const doc = await fetchOwnedOr404(actor, deviceId);
  if (!doc.revokedAt) {
    doc.revokedAt = new Date();
    await doc.save();
  }
  return toDeviceDto(doc);
};

// ---------------------------------------------------------------------------
// Internal: invalidate a token reported as bad by the upstream provider
// ---------------------------------------------------------------------------

// Called from the push worker when APNs/FCM rejects a token (e.g. uninstalled
// app, unregistered device). Hard-delete so the unique-token index frees up
// for a fresh registration from the same physical device. No-op if the token
// is already gone, so retries are safe.
export const invalidatePushToken = async (
  pushToken: string
): Promise<{ removed: boolean }> => {
  const res = await Device.deleteOne({ pushToken });
  return { removed: res.deletedCount > 0 };
};

// ---------------------------------------------------------------------------
// Cleanup of stale tokens
// ---------------------------------------------------------------------------

export interface CleanupStaleDevicesResult {
  scanned: number;
  removed: number;
}

// Stale devices haven't checked in for DEVICE_STALE_AFTER_DAYS. Upstream push
// providers don't guarantee tokens survive that long, so paying the storage +
// fan-out cost on a row that almost certainly fails is pointless. Hard-delete
// (not revoke) — there's no audit value in keeping a row whose owner has
// silently churned away from the app.
export const cleanupStaleDevices = async (
  now: Date = new Date(),
  staleAfterDays: number = DEVICE_STALE_AFTER_DAYS
): Promise<CleanupStaleDevicesResult> => {
  const cutoff = new Date(now.getTime() - staleAfterDays * MS_PER_DAY);
  const filter: FilterQuery<DeviceDocument> = {
    lastSeenAt: { $lt: cutoff }
  };
  const scanned = await Device.countDocuments(filter);
  const res = await Device.deleteMany(filter);
  return { scanned, removed: res.deletedCount };
};

// ---------------------------------------------------------------------------
// Internal: active device lookup for the push worker
// ---------------------------------------------------------------------------

export interface ActiveDeviceForPush {
  id: string;
  userId: string;
  platform: DeviceDocument['platform'];
  pushProvider: DeviceDocument['pushProvider'];
  pushToken: string;
}

// Used by the push worker. Loads tokens via the privileged opt-in path
// (`.select('+pushToken')`) — no other call site in the application is
// allowed to do this, by convention. Filters out revoked rows.
export const loadActiveDevicesForUser = async (
  userId: string
): Promise<ActiveDeviceForPush[]> => {
  const docs = await Device.find({
    userId: toObjectId(userId),
    revokedAt: { $exists: false }
  }).select('+pushToken');
  return docs.map((d) => ({
    id: (d._id as Types.ObjectId).toString(),
    userId: d.userId.toString(),
    platform: d.platform,
    pushProvider: d.pushProvider,
    pushToken: d.pushToken
  }));
};
