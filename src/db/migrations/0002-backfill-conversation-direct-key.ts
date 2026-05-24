import { Conversation, buildDirectKey } from '../../modules/conversations/conversation.model';
import { ConversationMember } from '../../modules/conversations/conversationMember.model';
import { CONVERSATION_TYPE } from '../../modules/conversations/conversation.types';
import type { Migration } from './types';

// `directKey` is what enforces "at most one direct conversation per ordered
// pair" via a unique sparse index on `conversations`. Direct conversations
// created BEFORE that field shipped do not have it set — without this
// backfill those legacy rows would (a) be allowed to be duplicated by a new
// create call and (b) never be found by the fast-path dedup lookup.
//
// This migration:
//   - finds every direct conversation missing `directKey`
//   - re-derives the key from its two active memberships (the sort inside
//     `buildDirectKey` keeps the key independent of which side wrote it)
//   - skips a conversation that doesn't have exactly two members rather
//     than guess — those rows belong to a broken legacy state that needs
//     operator review, not silent data invention
//
// Idempotency: the filter only matches rows still missing `directKey`, so
// re-running after a successful pass is a no-op. If a row was patched by
// hand in between runs (correct key already present), the filter ignores
// it too.
const migration: Migration = {
  name: '0002-backfill-conversation-direct-key',
  description:
    'Backfill conversations.directKey for legacy direct conversations created before the field shipped.',
  up: async (): Promise<void> => {
    const cursor = Conversation.find({
      type: CONVERSATION_TYPE.DIRECT,
      directKey: { $exists: false }
    }).cursor();

    for await (const conv of cursor) {
      const members = await ConversationMember.find({
        conversationId: conv._id
      }).select('userId');

      if (members.length !== 2) {
        // Direct conversations must have exactly two members. A row with
        // any other count is a data-integrity bug that this migration
        // refuses to paper over.
        continue;
      }

      const [a, b] = members;
      const key = buildDirectKey(a.userId.toString(), b.userId.toString());

      // Guarded update: only writes when directKey is still missing. Two
      // parallel runs of the migration cannot race-write conflicting keys
      // on the same row.
      await Conversation.updateOne(
        { _id: conv._id, directKey: { $exists: false } },
        { $set: { directKey: key } }
      );
    }
  }
};

export default migration;
