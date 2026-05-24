// Contact / contact-request types.
//
// A `Contact` row represents an active, accepted relationship between two
// users. We persist it as TWO directed rows (A→B and B→A) for two reasons:
//   1. The privacy gate that asks "is X a contact of Y?" becomes a single
//      single-row lookup keyed on (userId, contactUserId) — no $or expansion
//      across the index.
//   2. Removing your half of a contact is an explicit action the spec wants
//      ("remove contact"); storing both halves lets one side drop the link
//      without losing the other side's row until they choose to do the same.
//
// A `ContactRequest` row tracks a pending/accepted/declined/cancelled
// request. Only ONE row exists per (sender, receiver) ordered pair while it
// is `pending` — the unique partial index in contactRequest.model enforces
// that. Once moved to a terminal state the historic row stays in the
// collection (audit) but no longer blocks a fresh request.

export const CONTACT_REQUEST_STATUS = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  CANCELLED: 'cancelled'
} as const;

export type ContactRequestStatus =
  (typeof CONTACT_REQUEST_STATUS)[keyof typeof CONTACT_REQUEST_STATUS];

export const CONTACT_REQUEST_STATUSES: readonly ContactRequestStatus[] =
  Object.values(CONTACT_REQUEST_STATUS);

export const CONTACT_REQUEST_MESSAGE_MAX_LENGTH = 280;

export const LIST_CONTACTS_DEFAULT_LIMIT = 25;
export const LIST_CONTACTS_MAX_LIMIT = 100;
export const LIST_CONTACT_REQUESTS_DEFAULT_LIMIT = 25;
export const LIST_CONTACT_REQUESTS_MAX_LIMIT = 100;

export interface ContactDto {
  id: string;
  userId: string;
  contactUserId: string;
  createdAt: string;
}

export interface ContactRequestDto {
  id: string;
  senderId: string;
  receiverId: string;
  status: ContactRequestStatus;
  message?: string;
  createdAt: string;
  respondedAt?: string;
}

export interface ContactUserSummaryDto {
  id: string;
  username?: string;
  displayName: string;
  avatarUrl?: string;
}

export interface ContactListItemDto {
  contact: ContactDto;
  user: ContactUserSummaryDto;
}

export interface ContactRequestListItemDto {
  request: ContactRequestDto;
  // The "other side" of the request from the caller's perspective. For
  // incoming requests this is the sender; for outgoing it is the receiver.
  user: ContactUserSummaryDto;
}
