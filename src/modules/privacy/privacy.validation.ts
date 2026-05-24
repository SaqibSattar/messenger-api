import { z } from 'zod';
import { PRIVACY_AUDIENCE } from '../users/user.types';

const audienceSchema = z.enum([
  PRIVACY_AUDIENCE.EVERYONE,
  PRIVACY_AUDIENCE.CONTACTS,
  PRIVACY_AUDIENCE.NOBODY
]);

// All-optional patch shape. We keep both the discoverability flags AND the
// audience-scoped controls in one document on User.privacySettings; the
// dedicated privacy-settings endpoint is the canonical way to update them.
export const updatePrivacySettingsSchema = z
  .object({
    discoverableByEmail: z.boolean().optional(),
    discoverableByPhone: z.boolean().optional(),
    discoverableByUsername: z.boolean().optional(),
    showLastSeen: z.boolean().optional(),
    showOnlineStatus: z.boolean().optional(),
    whoCanFindMe: audienceSchema.optional(),
    whoCanMessageMe: audienceSchema.optional(),
    readReceiptsEnabled: z.boolean().optional(),
    onlineStatusVisibility: audienceSchema.optional(),
    profilePhotoVisibility: audienceSchema.optional()
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'No fields to update'
  });

export type UpdatePrivacySettingsInput = z.infer<
  typeof updatePrivacySettingsSchema
>;
