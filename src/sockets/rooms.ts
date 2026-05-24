// Server-controlled room names. Clients never name rooms directly — they only
// reference resources (a conversationId, their own user id) and the server
// translates those into room names after authorization passes. This is how the
// spec rule "never let clients choose arbitrary room names" is enforced.

export const userRoom = (userId: string): string => `user:${userId}`;

export const conversationRoom = (conversationId: string): string =>
  `conversation:${conversationId}`;
