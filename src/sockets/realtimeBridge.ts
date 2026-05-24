import {
  realtimeEvents,
  type RealtimeEventMap,
  type RealtimeEventName
} from '../services/realtimeEvents';
import type { AppServer } from './auth';
import { conversationRoom } from './rooms';

// Map each domain event from the in-process bus to a Socket.IO room emit.
// Keeping this mapping in one place means business code stays decoupled from
// socket I/O — services just call `emitRealtime('foo', payload)` and trust
// that authorized listeners will receive it.
//
// All current events are conversation-scoped, so they all fan out to
// `conversation:{conversationId}`. Membership is enforced at room-join time
// (handlers.ts), so emitting to that room cannot reach a non-member.

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

interface EventBinding<K extends RealtimeEventName> {
  source: K;
  outbound: string;
}

const BINDINGS: EventBinding<RealtimeEventName>[] = [
  { source: 'message.created', outbound: 'message.created' },
  { source: 'message.updated', outbound: 'message.updated' },
  { source: 'message.deleted', outbound: 'message.deleted' },
  { source: 'message.expired', outbound: 'message.expired' },
  { source: 'message.reaction_added', outbound: 'message.reaction_added' },
  { source: 'message.reaction_removed', outbound: 'message.reaction_removed' },
  { source: 'message.delivered', outbound: 'message.delivered' },
  { source: 'message.read', outbound: 'message.read' },
  {
    source: 'conversation.disappearing_settings_updated',
    outbound: 'conversation.disappearing_settings_updated'
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
    const forward = forwardToConversation(binding.outbound);
    const fn: BridgeListener = (payload: unknown) => {
      forward(io, payload as RealtimeEventMap[typeof binding.source]);
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
