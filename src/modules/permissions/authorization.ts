import { ForbiddenError } from '../../utils/errors';

export interface ResourceOwner {
  ownerId: string | { toString(): string };
}

export const assertOwnership = (
  resource: ResourceOwner,
  userId: string
): void => {
  if (resource.ownerId.toString() !== userId) {
    throw new ForbiddenError('You do not own this resource');
  }
};

// Resource-level checks below are placeholder signatures. The conversation and
// membership data model lands in module 04 (04-conversations-and-members.md);
// these helpers are then re-implemented to hit the real collections. Other
// modules should depend on these signatures so swapping the implementation
// later does not ripple through callers.
export const assertConversationMember = async (
  _conversationId: string,
  _userId: string
): Promise<void> => {
  throw new Error(
    'assertConversationMember not implemented — see module 04'
  );
};

export const assertConversationRole = async (
  _conversationId: string,
  _userId: string,
  _role: 'member' | 'moderator' | 'admin' | 'owner'
): Promise<void> => {
  throw new Error('assertConversationRole not implemented — see module 04');
};
