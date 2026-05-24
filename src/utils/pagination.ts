// Standard cursor-paginated list contract used across the messenger API.
//
// Every paginated list endpoint returns:
//
//   {
//     "items": [...],
//     "nextCursor": "<opaque-string>" | null
//   }
//
// `nextCursor === null` means the caller has reached the end of the list.
// Cursors are opaque to clients — never parse them client-side. The shape
// is centralized here so service authors can use one type instead of
// re-declaring an `items + nextCursor` pair in every module.
//
// Why we keep cursors opaque: today they are ObjectId strings, but the
// server is free to switch to base64-encoded composite keys for
// secondary-sort cases later without breaking the contract.

export interface PaginatedResult<T> {
  items: T[];
  nextCursor: string | null;
}

export const paginated = <T>(
  items: T[],
  nextCursor: string | null
): PaginatedResult<T> => ({ items, nextCursor });
