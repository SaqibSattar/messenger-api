import { z } from 'zod';

// Mongo ObjectIds are 24 hex chars. Matching the shape here lets us reject
// obvious junk payloads before any DB lookup. Service-layer code still does
// the authoritative membership/ownership checks.
const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, {
  message: 'Invalid id format'
});

export const conversationRefSchema = z
  .object({ conversationId: objectIdSchema })
  .strict();

export const messageRefSchema = z
  .object({ messageId: objectIdSchema })
  .strict();

export type ConversationRefPayload = z.infer<typeof conversationRefSchema>;
export type MessageRefPayload = z.infer<typeof messageRefSchema>;
