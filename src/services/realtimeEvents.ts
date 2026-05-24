import { EventEmitter } from 'node:events';
import type {
  MessageDto,
  MessageReactionDto,
  MessageReceiptDto
} from '../modules/messages/message.types';
import type { DisappearingMessageSettings } from '../modules/conversations/conversation.types';

/**
 * In-process realtime event bus.
 *
 * Feature services emit on this bus after a successful database write. The
 * socket bootstrap that lands with prompt 06 will subscribe and fan the event
 * out to the authorized conversation/user rooms — only emitting from the
 * service layer means business code never has to know about socket I/O, and
 * the socket layer never has to know about Mongo.
 *
 * Until the socket bootstrap lands, the bus has no listeners. EventEmitter is
 * safe to emit into with zero listeners, so emit calls are no-ops in that
 * window — the wiring stays in place, ready to be picked up.
 */
export interface RealtimeMessagePayload {
  conversationId: string;
  message: MessageDto;
}

export interface RealtimeReactionPayload {
  conversationId: string;
  messageId: string;
  reaction: MessageReactionDto;
}

export interface RealtimeReactionRemovedPayload {
  conversationId: string;
  messageId: string;
  reactionId: string;
  userId: string;
}

export interface RealtimeReceiptPayload {
  conversationId: string;
  messageId: string;
  receipt: MessageReceiptDto;
}

export interface RealtimeDisappearingSettingsPayload {
  conversationId: string;
  disappearingMessages: DisappearingMessageSettings;
}

export interface RealtimeMessageExpiredPayload {
  conversationId: string;
  messageId: string;
  // Carries the redacted DTO so listeners can replace local state directly.
  message: MessageDto;
}

export interface RealtimeEventMap {
  'message.created': RealtimeMessagePayload;
  'message.updated': RealtimeMessagePayload;
  'message.deleted': RealtimeMessagePayload;
  'message.expired': RealtimeMessageExpiredPayload;
  'message.reaction_added': RealtimeReactionPayload;
  'message.reaction_removed': RealtimeReactionRemovedPayload;
  'message.delivered': RealtimeReceiptPayload;
  'message.read': RealtimeReceiptPayload;
  'conversation.disappearing_settings_updated': RealtimeDisappearingSettingsPayload;
}

export type RealtimeEventName = keyof RealtimeEventMap;

class RealtimeEventBus extends EventEmitter {}

export const realtimeEvents = new RealtimeEventBus();

// Surfacing a typed emit keeps callers honest about payload shapes. The bus
// itself stays a vanilla EventEmitter so the socket subscriber can register
// listeners by name without re-declaring the map.
export const emitRealtime = <K extends RealtimeEventName>(
  event: K,
  payload: RealtimeEventMap[K]
): void => {
  realtimeEvents.emit(event, payload);
};
