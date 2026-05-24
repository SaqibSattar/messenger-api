import mongoose, { type FilterQuery, type Types } from 'mongoose';
import { logger } from '../../utils/logger';
import { ForbiddenError } from '../../utils/errors';
import { PERMISSIONS } from '../permissions/permissions.constants';
import type { AuthenticatedActor } from '../permissions/authorization';
import {
  AuditLog,
  toAuditLogDto,
  type AuditLogDocument
} from './auditLog.model';
import type { AuditLogDto, AuditTargetType } from './auditLog.types';

// ---------------------------------------------------------------------------
// Metadata sanitisation
// ---------------------------------------------------------------------------
//
// Audit metadata is built by services using known fields, but a defensive
// sanitiser runs on every write so a regression that leaks a secret into the
// payload cannot reach the database. The sanitiser:
//
//   - strips keys whose names look like secrets (token, password, secret, …)
//   - drops keys that look like Mongo operators (`$...`) or paths (`...a.b`)
//   - truncates long strings
//   - bounds object width, array length, and recursion depth
//
// `[REDACTED]` / `[TRUNCATED]` markers are intentional — they preserve the
// shape of the event for a reviewer while making the redaction obvious.

const SENSITIVE_KEY_RE =
  /(password|token|bearer|authorization|cookie|secret|otp|reset.?code|verify.?code|private.?key|api.?key)/i;

const STRING_MAX = 500;
const MAX_KEYS_PER_OBJECT = 32;
const MAX_ARRAY_LEN = 32;
const MAX_DEPTH = 4;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;

const truncateString = (s: string): string =>
  s.length <= STRING_MAX ? s : s.slice(0, STRING_MAX - 1) + '…';

const sanitizeValue = (value: unknown, depth: number): unknown => {
  if (depth > MAX_DEPTH) return '[TRUNCATED_DEPTH]';
  if (value === null) return null;
  if (typeof value === 'string') return truncateString(value);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const out = value
      .slice(0, MAX_ARRAY_LEN)
      .map((v) => sanitizeValue(v, depth + 1))
      .filter((v) => v !== undefined);
    if (value.length > MAX_ARRAY_LEN) out.push('[TRUNCATED]');
    return out;
  }
  if (isPlainObject(value)) {
    return sanitizeObject(value, depth + 1);
  }
  // Functions, symbols, bigint, dates, regexes, etc. — drop. Reviewers should
  // not be relying on these in a structured audit record.
  return undefined;
};

const sanitizeObject = (
  obj: Record<string, unknown>,
  depth: number
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  let count = 0;
  for (const [key, val] of Object.entries(obj)) {
    if (count >= MAX_KEYS_PER_OBJECT) break;
    if (typeof key !== 'string' || key.length === 0) continue;
    // Block Mongo operator / dot-path keys. Audit metadata is consumer-facing
    // JSON; these have no legitimate place in it and would be a red flag if
    // they appeared via a regression.
    if (key.startsWith('$') || key.includes('.')) continue;
    if (SENSITIVE_KEY_RE.test(key)) {
      result[key] = '[REDACTED]';
      count++;
      continue;
    }
    const sanitized = sanitizeValue(val, depth);
    if (sanitized === undefined) continue;
    result[key] = sanitized;
    count++;
  }
  return result;
};

export const sanitizeAuditMetadata = (
  input: Record<string, unknown>
): Record<string, unknown> => sanitizeObject(input, 0);

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface PersistAuditLogInput {
  actorId?: string;
  action: string;
  targetType?: AuditTargetType;
  targetId?: string;
  requestId?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

const OBJECT_ID_RE = /^[a-fA-F0-9]{24}$/;

export const persistAuditLog = async (
  input: PersistAuditLogInput
): Promise<void> => {
  try {
    const doc: Record<string, unknown> = { action: input.action };
    if (input.actorId && OBJECT_ID_RE.test(input.actorId)) {
      doc.actorId = new mongoose.Types.ObjectId(input.actorId);
    }
    if (input.targetType) doc.targetType = input.targetType;
    if (input.targetId) doc.targetId = input.targetId.slice(0, 64);
    if (input.requestId) doc.requestId = input.requestId.slice(0, 64);
    if (input.ipAddress) doc.ipAddress = input.ipAddress.slice(0, 64);
    if (input.userAgent) doc.userAgent = input.userAgent.slice(0, 500);
    if (input.metadata) doc.metadata = sanitizeAuditMetadata(input.metadata);
    await AuditLog.create(doc);
  } catch (err) {
    // Never propagate — an audit failure must not break the audited action.
    // The structured log line is the secondary trail in this case.
    logger.warn({ err, action: input.action }, 'audit persistence failed');
  }
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ListAuditLogsQuery {
  cursor?: string;
  limit: number;
  actorId?: string;
  action?: string;
  targetType?: AuditTargetType;
  targetId?: string;
  since?: Date;
  until?: Date;
}

export interface ListAuditLogsResult {
  items: AuditLogDto[];
  nextCursor: string | null;
}

export const listAuditLogs = async (
  actor: AuthenticatedActor,
  query: ListAuditLogsQuery
): Promise<ListAuditLogsResult> => {
  // Two-layer auth: the admin route already gates on ADMIN_AUDIT_READ via
  // route middleware. We double-check here so direct service callers (jobs,
  // future tooling) cannot bypass it.
  if (!actor.permissions.includes(PERMISSIONS.ADMIN_AUDIT_READ)) {
    throw new ForbiddenError('You cannot view audit logs');
  }

  const filter: FilterQuery<AuditLogDocument> = {};
  if (query.actorId) {
    filter.actorId = new mongoose.Types.ObjectId(query.actorId);
  }
  if (query.action) filter.action = query.action;
  if (query.targetType) filter.targetType = query.targetType;
  if (query.targetId) filter.targetId = query.targetId;
  if (query.since || query.until) {
    const range: Record<string, Date> = {};
    if (query.since) range.$gte = query.since;
    if (query.until) range.$lte = query.until;
    filter.createdAt = range;
  }
  if (query.cursor) {
    filter._id = { $lt: new mongoose.Types.ObjectId(query.cursor) };
  }

  const docs = await AuditLog.find(filter)
    .sort({ _id: -1 })
    .limit(query.limit + 1);

  const hasMore = docs.length > query.limit;
  const page = hasMore ? docs.slice(0, query.limit) : docs;
  const lastId =
    page.length > 0
      ? (page[page.length - 1]._id as Types.ObjectId).toString()
      : null;

  return {
    items: page.map(toAuditLogDto),
    nextCursor: hasMore ? lastId : null
  };
};
