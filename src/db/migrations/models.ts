// Side-effecting imports: pulling in every model file registers its schema
// with Mongoose so the migration runner can iterate `mongoose.modelNames()`
// without each migration having to know about every collection.
//
// Whenever a new collection is added, add its model module here. Tests use
// the same trick (via tests/db.ts → ensureIndexes) but pull models lazily
// because most suites import the models they need directly; the migration
// runner cannot rely on that, so we centralize the registration here.

import '../../modules/admin/auditLog.model';
import '../../modules/contacts/contact.model';
import '../../modules/contacts/contactRequest.model';
import '../../modules/conversations/conversation.model';
import '../../modules/conversations/conversationMember.model';
import '../../modules/devices/device.model';
import '../../modules/invites/inviteLink.model';
import '../../modules/media/attachment.model';
import '../../modules/messages/message.model';
import '../../modules/messages/messageReaction.model';
import '../../modules/messages/messageReceipt.model';
import '../../modules/moderation/block.model';
import '../../modules/moderation/moderationAction.model';
import '../../modules/moderation/report.model';
import '../../modules/notifications/notification.model';
import '../../modules/notifications/notificationPreference.model';
import '../../modules/notifications/conversationNotificationPreference.model';
import '../../modules/sessions/session.model';
import '../../modules/stories/story.model';
import '../../modules/stories/storyMute.model';
import '../../modules/stories/storyView.model';
import '../../modules/users/user.model';
