import { UnauthorizedError } from '../../utils/errors';
import { User, resolvePrivacySettings } from '../users/user.model';
import {
  DEFAULT_PRIVACY_SETTINGS,
  PRIVACY_AUDIENCE,
  type PrivacyAudience,
  type PrivacySettings
} from '../users/user.types';
import type { AuthenticatedActor } from '../permissions/authorization';
import { areMutualContacts } from '../contacts/contact.service';
import type { UpdatePrivacySettingsInput } from './privacy.validation';

// The allowed-keys set is the single source of truth for "what is a privacy
// field" — adding a new field requires touching this list, the schema, the
// validator, AND DEFAULT_PRIVACY_SETTINGS, which is intentional friction.
const PRIVACY_KEYS = new Set<keyof PrivacySettings>([
  'discoverableByEmail',
  'discoverableByPhone',
  'discoverableByUsername',
  'showLastSeen',
  'showOnlineStatus',
  'whoCanFindMe',
  'whoCanMessageMe',
  'readReceiptsEnabled',
  'onlineStatusVisibility',
  'profilePhotoVisibility'
]);

const mergePatchOntoCurrent = (
  current: PrivacySettings,
  patch: Partial<PrivacySettings>
): PrivacySettings => {
  const next: PrivacySettings = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (!PRIVACY_KEYS.has(key as keyof PrivacySettings)) continue;
    // Defensive cast — the validator already enforced the per-field type.
    (next as unknown as Record<string, unknown>)[key] = value;
  }
  return next;
};

export const getMyPrivacySettings = async (
  actor: AuthenticatedActor
): Promise<PrivacySettings> => {
  const user = await User.findById(actor.id);
  if (!user) throw new UnauthorizedError();
  return resolvePrivacySettings(user);
};

export const updateMyPrivacySettings = async (
  actor: AuthenticatedActor,
  input: UpdatePrivacySettingsInput
): Promise<PrivacySettings> => {
  const user = await User.findById(actor.id);
  if (!user) throw new UnauthorizedError();
  // Read the current settings via the model helper so we work on a plain
  // POJO, not a Mongoose subdocument whose internal markers leak through a
  // naive spread.
  const merged = mergePatchOntoCurrent(resolvePrivacySettings(user), input);
  user.privacySettings = merged;
  // Reassigning a nested object can be missed by Mongoose's change tracking
  // if the parent already had a subdoc — markModified is the safe belt-and-
  // braces signal.
  user.markModified('privacySettings');
  await user.save();
  return resolvePrivacySettings(user);
};

// ---------------------------------------------------------------------------
// Audience evaluation helpers
//
// Other modules call these to ask "can the viewer interact with the subject?"
// based on the subject's audience-scoped settings. The helpers are async
// because evaluating CONTACTS requires a contact lookup; they collapse to a
// cheap synchronous answer for EVERYONE / NOBODY.
// ---------------------------------------------------------------------------

const isAudienceAllowed = async (
  audience: PrivacyAudience,
  viewerId: string,
  subjectId: string
): Promise<boolean> => {
  if (viewerId === subjectId) return true;
  switch (audience) {
    case PRIVACY_AUDIENCE.EVERYONE:
      return true;
    case PRIVACY_AUDIENCE.NOBODY:
      return false;
    case PRIVACY_AUDIENCE.CONTACTS:
      return areMutualContacts(viewerId, subjectId);
  }
};

// "Can `viewerId` discover/find `subjectId`?" — honors whoCanFindMe.
export const canDiscoverUser = async (
  viewerId: string,
  subject: { _id: { toString(): string }; privacySettings?: PrivacySettings }
): Promise<boolean> => {
  const subjectId = subject._id.toString();
  const audience =
    subject.privacySettings?.whoCanFindMe ??
    DEFAULT_PRIVACY_SETTINGS.whoCanFindMe;
  return isAudienceAllowed(audience, viewerId, subjectId);
};

// "Can `viewerId` send `subjectId` a direct message?" — honors
// whoCanMessageMe. Returns false for both the "DM creation" and "ongoing DM
// send" cases; callers must NOT distinguish in the error message, lest they
// leak the subject's setting.
export const canMessageUser = async (
  viewerId: string,
  subject: { _id: { toString(): string }; privacySettings?: PrivacySettings }
): Promise<boolean> => {
  const subjectId = subject._id.toString();
  const audience =
    subject.privacySettings?.whoCanMessageMe ??
    DEFAULT_PRIVACY_SETTINGS.whoCanMessageMe;
  return isAudienceAllowed(audience, viewerId, subjectId);
};

// "Can `viewerId` see `subjectId`'s avatar/profile photo?" — honors
// profilePhotoVisibility. Used by the public profile DTO builder.
export const canSeeProfilePhoto = async (
  viewerId: string,
  subject: { _id: { toString(): string }; privacySettings?: PrivacySettings }
): Promise<boolean> => {
  const subjectId = subject._id.toString();
  const audience =
    subject.privacySettings?.profilePhotoVisibility ??
    DEFAULT_PRIVACY_SETTINGS.profilePhotoVisibility;
  return isAudienceAllowed(audience, viewerId, subjectId);
};

// "Can `viewerId` see `subjectId`'s online/presence status?" — honors
// onlineStatusVisibility. Used by presence projection in future surfaces.
export const canSeeOnlineStatus = async (
  viewerId: string,
  subject: { _id: { toString(): string }; privacySettings?: PrivacySettings }
): Promise<boolean> => {
  const subjectId = subject._id.toString();
  const audience =
    subject.privacySettings?.onlineStatusVisibility ??
    DEFAULT_PRIVACY_SETTINGS.onlineStatusVisibility;
  return isAudienceAllowed(audience, viewerId, subjectId);
};
