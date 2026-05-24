import {
  realtimeEvents,
  type RealtimeEventMap,
  type RealtimeEventName
} from '../services/realtimeEvents';
import type { AppServer } from './auth';
import { conversationRoom, userRoom } from './rooms';

// Map each domain event from the in-process bus to a Socket.IO room emit.
// Keeping this mapping in one place means business code stays decoupled from
// socket I/O — services just call `emitRealtime('foo', payload)` and trust
// that authorized listeners will receive it.
//
// Conversation-scoped events fan out to `conversation:{conversationId}`;
// membership is enforced at room-join time (handlers.ts) so a non-member
// cannot be reached. Story-scoped events fan out per-user using the
// service-computed `viewerIds` list — each recipient was already audience-
// authorized in the story service.

type Forwarder<K extends RealtimeEventName> = (
  io: AppServer,
  payload: RealtimeEventMap[K]
) => void;

const forwardToConversation = <K extends RealtimeEventName>(
  outboundName: string
): Forwarder<K> => {
  return (io, payload) => {
    const conversationId = (payload as { conversationId: string }).conversationId;
    io.to(conversationRoom(conversationId)).emit(outboundName, payload);
  };
};

// Story.created / story.deleted / story.expired carry a service-computed
// `viewerIds`. Fan out to each viewer's user room (and the author's, so the
// author sees their own update reflected on other devices).
const forwardStoryAudienceEvent = <K extends RealtimeEventName>(
  outboundName: string
): Forwarder<K> => {
  return (io, payload) => {
    const p = payload as { authorId: string; viewerIds?: string[] };
    const rooms = new Set<string>([userRoom(p.authorId)]);
    for (const id of p.viewerIds ?? []) rooms.add(userRoom(id));
    for (const room of rooms) {
      io.to(room).emit(outboundName, payload);
    }
  };
};

// story.viewed is author-only — the owner is the one who needs to know.
const forwardStoryViewed = <K extends RealtimeEventName>(
  outboundName: string
): Forwarder<K> => {
  return (io, payload) => {
    const p = payload as { authorId: string };
    io.to(userRoom(p.authorId)).emit(outboundName, payload);
  };
};

interface EventBinding<K extends RealtimeEventName> {
  source: K;
  outbound: string;
  forward: Forwarder<K>;
}

const BINDINGS: EventBinding<RealtimeEventName>[] = [
  {
    source: 'message.created',
    outbound: 'message.created',
    forward: forwardToConversation('message.created')
  },
  {
    source: 'message.updated',
    outbound: 'message.updated',
    forward: forwardToConversation('message.updated')
  },
  {
    source: 'message.deleted',
    outbound: 'message.deleted',
    forward: forwardToConversation('message.deleted')
  },
  {
    source: 'message.expired',
    outbound: 'message.expired',
    forward: forwardToConversation('message.expired')
  },
  {
    source: 'message.reaction_added',
    outbound: 'message.reaction_added',
    forward: forwardToConversation('message.reaction_added')
  },
  {
    source: 'message.reaction_removed',
    outbound: 'message.reaction_removed',
    forward: forwardToConversation('message.reaction_removed')
  },
  {
    source: 'message.delivered',
    outbound: 'message.delivered',
    forward: forwardToConversation('message.delivered')
  },
  {
    source: 'message.read',
    outbound: 'message.read',
    forward: forwardToConversation('message.read')
  },
  {
    source: 'conversation.disappearing_settings_updated',
    outbound: 'conversation.disappearing_settings_updated',
    forward: forwardToConversation('conversation.disappearing_settings_updated')
  },
  {
    source: 'story.created',
    outbound: 'story.created',
    forward: forwardStoryAudienceEvent('story.created')
  },
  {
    source: 'story.deleted',
    outbound: 'story.deleted',
    forward: forwardStoryAudienceEvent('story.deleted')
  },
  {
    source: 'story.expired',
    outbound: 'story.expired',
    forward: forwardStoryAudienceEvent('story.expired')
  },
  {
    source: 'story.viewed',
    outbound: 'story.viewed',
    forward: forwardStoryViewed('story.viewed')
  }
];

type BridgeListener = (...args: unknown[]) => void;

const subscriptions = new WeakMap<AppServer, Array<{ event: string; fn: BridgeListener }>>();

export const attachRealtimeBridge = (io: AppServer): void => {
  // Idempotent: detach any previous bindings for this Server instance first.
  // Without this, a process that recreated `io` (test setup/teardown loops)
  // would accumulate listeners and double-emit.
  detachRealtimeBridge(io);

  const installed: Array<{ event: string; fn: BridgeListener }> = [];
  for (const binding of BINDINGS) {
    const fn: BridgeListener = (payload: unknown) => {
      binding.forward(io, payload as RealtimeEventMap[typeof binding.source]);
    };
    realtimeEvents.on(binding.source, fn);
    installed.push({ event: binding.source, fn });
  }
  subscriptions.set(io, installed);
};

export const detachRealtimeBridge = (io: AppServer): void => {
  const installed = subscriptions.get(io);
  if (!installed) return;
  for (const { event, fn } of installed) {
    realtimeEvents.off(event, fn);
  }
  subscriptions.delete(io);
};
