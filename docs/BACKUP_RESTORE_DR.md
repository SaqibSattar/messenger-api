# Backup, restore, and disaster recovery

This document is the **operational policy** for protecting messenger-api
production data and recovering from outages. It pairs with the spec in
[`messenger-nodejs-production-prompts/18-backup-restore-disaster-recovery.md`](../messenger-nodejs-production-prompts/18-backup-restore-disaster-recovery.md)
and the engineering rules in [`AGENTS.md`](../AGENTS.md). Operational
context for what each cleanup job touches lives in
[`PRIVACY_RETENTION.md`](./PRIVACY_RETENTION.md).

The service intentionally treats **MongoDB and object storage as the only
sources of truth**. Redis is a cache + coordination plane. The push job is
in-process and non-durable. Those three statements drive every decision
below.

---

## Backup scope

| Asset | Source of truth? | Backup target | Cadence |
| --- | --- | --- | --- |
| MongoDB data | **Yes.** | Managed snapshots + scheduled `mongodump` to private object storage. | Continuous (oplog) + daily logical dump. |
| Object storage media (attachments) | **Yes.** | Cross-region replication on the bucket; versioning enabled. | Continuous (provider). |
| Encryption / signing secrets | **Yes** (without these, restore is useless). | Secrets manager with versioned history. | On every rotation. |
| Deployment configuration (`.env` template, infra-as-code, Dockerfile, compose) | **Yes.** | Git + secrets manager (the runtime values). | Git history. |
| Redis state (presence, typing, rate-limit counters, Socket.IO pub/sub, push queue) | **No** — cache and coordination only. | **Not backed up.** Rebuilt on restart. | n/a |
| Process-level metrics, logs | **No.** | Log aggregator retention; not part of DR for this service. | n/a |

### Why Redis is not backed up

Every Redis key in this service is one of:

- **Presence** (`presence:user:*`) — TTL of `PRESENCE_TTL_SECONDS` (default
  90s). Repopulates as clients reconnect.
- **Typing indicators** — short-lived, ephemeral by design.
- **Rate-limit counters** — losing them at most lets a recent attacker
  retry; this is a stale-cache risk, not a data-loss risk.
- **Socket.IO adapter pub/sub** — stateless; the adapter re-binds at
  startup.
- **Push job queue** — see "Queue recovery" below.

None of those needs a snapshot. Treat Redis as **rebuildable from the
application's source of truth**; this matches the rule in `AGENTS.md`
("Do not treat Redis as the source of truth unless explicitly designed
that way").

---

## MongoDB backup strategy

**Two layers, always both:**

1. **Provider snapshots** (recommended: MongoDB Atlas continuous backup,
   AWS DocumentDB continuous backup, or equivalent). These give
   point-in-time restore down to the second-most-recent oplog entry
   without extra tooling. **Target RPO ≤ 60s.**
2. **Logical dumps** via `mongodump` on a daily cadence, written to a
   private, encrypted bucket in a *different* region than the primary
   cluster, with object-lock / versioning enabled.

```bash
# Daily logical dump (run from a backup host that has read access).
mongodump \
  --uri="$MONGODB_URI" \
  --gzip \
  --archive="messenger-$(date -u +%Y%m%dT%H%M%SZ).archive.gz"
# Then upload to the off-region private backup bucket.
```

Retention:

- **Continuous snapshots:** 7 days.
- **Daily dumps:** 30 days.
- **Monthly dumps:** 12 months (one promoted dump per month, used for
  compliance and long-tail recovery only).

Verification: every dump uploaded is followed by a checksum (sha256) that
the backup bucket stores alongside the archive. A weekly job (`drill`,
below) downloads a random dump and verifies the checksum + opens the
archive header — a corrupted dump is a backup that does not exist.

### Required indexes after restore

The collection-level migrations in
[`src/db/migrations/`](../src/db/migrations) are **idempotent and
non-destructive**. After a restore, run:

```bash
npm run migrate
```

…before re-attaching the API. The migration runner creates any missing
indexes (`0001-sync-indexes.ts`) and re-derives derived state
(`0002-backfill-conversation-direct-key.ts`). Skipping this step yields a
running service whose unique-membership / direct-key invariants are not
enforced — old uniqueness constraints will fail to fire on writes that
race with the index build.

---

## Object storage backup strategy

Media attachments are referenced from `attachments.storageKey` in Mongo;
the bytes themselves live in object storage. Losing one without the
other leaves dangling references in the UI ("attachment unavailable") or
orphan objects in the bucket — neither is recoverable from the other.

**Required configuration on the production bucket (S3 or equivalent):**

- **Versioning ON.** A delete is a tombstone; the prior version is
  recoverable.
- **Cross-region replication ON.** Replicates new objects to a secondary
  region within minutes. The secondary bucket is read-only failover.
- **Object lock** (or equivalent immutability) for at least 30 days. A
  compromised access key cannot purge an immutable object before the
  lock expires.
- **Lifecycle rule** that transitions noncurrent versions to cold
  storage after 30 days and expires them after 365 days. Mirrors the
  retention windows in [`PRIVACY_RETENTION.md`](./PRIVACY_RETENTION.md).
- **Bucket policy denies public ACLs.** Private media must only be
  served via the signed-URL flow in
  [`src/modules/media/storage.ts`](../src/modules/media/storage.ts).

The service never relies on object-storage backups for the metadata —
the metadata is in Mongo. Restoring the bucket without restoring Mongo
recovers files that nothing references; restoring Mongo without the
bucket recovers references to files that no longer exist.

---

## Redis persistence expectations

The service runs Redis as a cache + adapter, not as a database. The
recommended production configuration:

- **AOF off, RDB off** is acceptable. The service can repopulate every
  key from cold start.
- If your platform forces persistence on (e.g. ElastiCache with
  snapshots), there is no harm — just don't *rely* on it.
- **Auth required.** Redis hosts presence and rate-limit counters; an
  attacker with raw access can forge presence or reset rate limits.
- **Private network only.** Never expose the Redis port to the public
  internet, even with auth.

On Redis restart: presence resets to empty, typing indicators clear,
rate-limit windows reset (this is acceptable — at most we forgive a
short burst from clients we would otherwise have throttled), Socket.IO
clients reconnect and rejoin rooms via the normal `socket.auth` flow.

---

## Queue recovery

**The push-notification "queue" is in-process and non-durable.** See
[`src/jobs/pushNotificationJob.ts`](../src/jobs/pushNotificationJob.ts):
`enqueuePushNotification` is a fire-and-forget `void runPushFanOut(...)`.
If the process dies mid-fan-out, the inbox row in Mongo is already
committed (the user sees the message next time they fetch
`/notifications`), but the device-level push for that one notification
is lost.

Operational implications:

- **Notifications are durable.** Inbox state lives in Mongo and is
  recoverable from snapshot.
- **Push deliveries are best-effort.** A node restart drops in-flight
  push jobs. This is acceptable because (a) the inbox is the source of
  truth, and (b) the client polls / reconnects on resume.
- **Do not move durable side effects into the push worker.** If a
  future feature needs at-least-once delivery, introduce a real queue
  (BullMQ on Redis with AOF, SQS, etc.) — do not bolt durability onto
  the placeholder transport.

Other background jobs in [`src/jobs/`](../src/jobs) — `expireMessages`,
`cleanupAttachments`, `cleanupDevices`, `cleanupNotifications`,
`cleanupInvites`, `cleanupSessions`, `finalizeAccountDeletions` — are
**idempotent sweeps over Mongo**. Recovery from a worker crash is "run
the job again": every per-document update is guarded by a filter that
becomes false once the work is done. No state is held outside Mongo.

---

## Secrets backup and rotation

Backed-up secrets live in the operator's secrets manager (AWS Secrets
Manager, HashiCorp Vault, GCP Secret Manager). The application reads
them only at startup via environment variables — the secrets manager
itself is the durable copy.

**Versioning is mandatory.** Every rotation produces a new version; the
prior version is retained for the rollback window below.

| Secret | Rotation cadence | Rollback window |
| --- | --- | --- |
| `JWT_ACCESS_SECRET` | 90 days, or immediately on suspicion. | 24h — long enough for the longest access token (`ACCESS_TOKEN_TTL`, default 15m) to expire. |
| `JWT_REFRESH_SECRET` | 180 days, or immediately on suspicion. | None — rotating invalidates every active refresh token. Plan for a user-visible re-login. |
| `STORAGE_SIGNING_SECRET` | 365 days, or immediately on suspicion. | Window equal to `MEDIA_UPLOAD_URL_TTL_SECONDS` + `MEDIA_DOWNLOAD_URL_TTL_SECONDS` (default 900s + 300s) — once outstanding signed URLs expire, the old secret can be retired. |
| `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY` | 90 days, or immediately on suspicion. | None — provider-side rotation, dual-key handoff supported. |
| `MONGODB_URI` password | 90 days. | Mongo supports dual-password during rotation. |
| `REDIS_URL` password | 90 days. | Restart re-reads the env. |

Password hashes (argon2) are **not recoverable** and not part of any
secret manager — they only live in Mongo. A compromised database
exposes hashes, not plaintext; this is the expected failure mode and
the reason argon2 is required.

---

## Restore process

### Order matters

1. **Secrets first.** Restore the secrets manager (or confirm it is
   intact). Without `JWT_*` and `STORAGE_*`, the API will refuse to
   boot (`src/config/env.ts` fails fast on missing production secrets).
2. **MongoDB next.** Without Mongo, every readiness check fails and the
   API will not accept traffic.
3. **Object storage next.** Mongo references storage keys; restoring
   storage after Mongo is fine, but starting traffic before storage is
   reachable means attachment routes will 502 until the bucket is up.
4. **Redis last.** Redis is rebuilt by client activity. Bringing it up
   before clients reconnect costs nothing but is not load-bearing.
5. **Run migrations.** `npm run migrate` against the restored cluster
   before the first API process starts.
6. **Re-attach the API.** Workers, then HTTP, then sockets. Confirm
   `/ready` returns 200.

### MongoDB point-in-time restore

Provider snapshot path:

1. In the provider console, pick a restore point. **Target RPO ≤ 60s**
   from the incident timestamp.
2. Restore to a **new cluster**, not the existing one. Never overwrite
   the running primary — a botched restore on top of partial state is
   unrecoverable.
3. Promote the new cluster by repointing `MONGODB_URI` in the secrets
   manager and bouncing the API.

`mongodump` path (only when continuous backup is unavailable):

```bash
# Restore the most recent verified dump.
mongorestore \
  --uri="$MONGODB_URI_TARGET" \
  --gzip \
  --archive="messenger-YYYYMMDDTHHMMSSZ.archive.gz" \
  --drop                # Replace existing collections wholesale.
```

The `--drop` flag is destructive. Use it only when restoring into a
known-empty target cluster.

### Object-storage restore

- **Recent accidental delete:** restore the prior version via
  `aws s3api list-object-versions` + `restore-object`. The bucket has
  versioning on; the prior version is the most recent non-tombstone.
- **Region outage:** point `STORAGE_BUCKET` and `STORAGE_REGION` at the
  replicated secondary bucket. Replication is read-only by default;
  promote it to read-write when the primary region is confirmed lost,
  not before.
- **Bulk restore from cold storage:** issue lifecycle restores for the
  affected key prefixes. Allow up to 12h for retrieval; clients will
  see "attachment unavailable" until restore completes.

### Validating restored data

After any restore, before re-attaching traffic:

1. **Schema check:** `npm run migrate` exits cleanly (no missing
   indexes, no backfill remaining).
2. **Sample-fetch invariants:**
   - Pick 10 recent conversations, confirm message counts are within
     ±1 of the snapshot manifest.
   - Pick 10 attachments and resolve their storage keys against the
     restored bucket — every key must 200.
   - Pick 10 users with active sessions: their TTL'd session rows must
     either be present (within their original expiry) or absent (TTL
     evicted them); a session with `expiresAt < now()` that is still
     present means the TTL index didn't get created — re-run migrate.
3. **Run the integration test suite** against the restored cluster (in
   a staging API instance, never against production traffic).
4. **Smoke `/ready`** — both Mongo and Redis must be reachable. The
   readiness check is in [`src/app.ts:115`](../src/app.ts#L115) and
   covers exactly the dependencies the service refuses to serve
   traffic without.

### Partially processed jobs

For each background sweep (`src/jobs/*`), recovery is "run the job
again." The jobs are idempotent — running them on the restored cluster
is safe and recommended as the first post-restore step before
re-attaching the API.

The push fan-out queue does not survive a restart by design. After a
restore there is nothing to recover; the inbox is intact in Mongo and
clients will see notifications on next sync.

---

## Disaster runbooks

Each runbook below is the minimal sequence to (a) confirm the failure,
(b) stop the bleeding, and (c) restore service. Detailed timing,
paging, and post-mortem templates live in the operator's incident
process; this section is the engineering steps only.

### MongoDB outage

**Symptoms.** `/ready` returns 503 with `checks.mongo: false`. All
write paths return 500. `mongoose.connection.readyState !== 1`.

1. **Confirm scope.** Provider status page + a manual `mongosh
   "$MONGODB_URI"` from a bastion. Is it the cluster, a region, or a
   network blip?
2. **If transient (< 5 min):** the API auto-reconnects; no action.
   Mongoose buffers a small number of operations before failing them.
3. **If sustained:**
   - Page the database on-call.
   - Failover to the secondary replica if the primary is the only
     casualty.
   - Promote the off-region restore cluster only if the entire primary
     region is gone. Follow [Restore process](#restore-process).
4. **Do not** delete the existing cluster while attempting restore. A
   ghost cluster is harmless; an over-eager teardown is permanent.

### Redis outage

**Symptoms.** `/ready` returns 503 with `checks.redis: false`. Presence
stops updating. Socket.IO room broadcasts stop fanning across
instances. Rate-limit middleware returns 500.

1. **The API stops accepting traffic** because `/ready` fails — the
   load balancer will drain it. This is correct: without Redis, the
   rate limiter, socket adapter, and presence subsystem cannot
   function safely.
2. **Restart Redis** or fail over to a replica. No state restoration is
   required; clients repopulate on reconnect.
3. **Bring the API back** once Redis returns. `/ready` will flip to
   200; the load balancer reattaches.
4. **Do not** try to "rescue" presence by importing a snapshot. There
   is none, and there should not be one.

### Object storage outage

**Symptoms.** Attachment uploads (`POST /media/uploads`) return 5xx.
Download URL generation works (the service signs URLs without calling
storage) but the URLs themselves 5xx when the client hits them.

1. **Mongo is unaffected.** Text messages, presence, conversations,
   sockets all continue to work — `/ready` stays 200.
2. **If transient:** clients retry uploads automatically (per the
   media-upload flow); no action.
3. **If sustained:**
   - Fail over `STORAGE_BUCKET` / `STORAGE_REGION` to the replicated
     secondary bucket and bounce the API.
   - For S3, promote the replicated bucket to read-write only after the
     primary region is confirmed lost.
4. **Do not** force `STORAGE_PROVIDER=memory` in production to "keep
   uploads working." The memory provider does not persist bytes; it
   would silently lose every attachment.

### Queue worker failure (push fan-out)

**Symptoms.** Inbox rows are created but no device receives a push.

The push transport is fire-and-forget. There is no queue to drain or
worker to restart in the traditional sense — every API process runs
the worker in-process.

1. **Confirm the inbox row exists** in `notifications` — if it does,
   the user state is correct.
2. **Check the push-provider side** (APNs / FCM). Most "queue worker
   failure" symptoms are actually upstream provider failures, not local
   ones.
3. **Restart the API process** if the in-process worker is stuck (e.g.
   a hung HTTP keep-alive to the push provider). Inbox state survives
   the restart; in-flight push attempts are lost by design.
4. **For sustained provider outages,** there is no replay. Users see
   the notification on next inbox sync; the badge count is correct.

### Accidental data deletion

**Symptoms.** A user, conversation, message, or attachment that should
exist is gone. Audit logs in `audit_logs` may indicate whether the
delete came from a moderation action, a finalize sweep, or a manual
operation.

1. **Stop the bleeding first.** If a script is running, kill it. If a
   misbehaving job, disable it. Do not start a restore over an active
   delete loop.
2. **Identify the blast radius.** Query `audit_logs` for the deleting
   actor and time window. The audit pipeline records who did what; see
   [`auditLog.service.ts`](../src/modules/admin/auditLog.service.ts).
3. **Targeted restore.** Restore to a *new* cluster from a snapshot
   before the deletion. **Do not restore over production.** Extract
   only the affected documents and re-insert them into the live
   cluster. Bulk overwriting reintroduces every concurrent
   modification that happened between the snapshot and now.
4. **For accidentally deleted attachments:** restore the prior version
   from the object-storage bucket. The Mongo `attachments` row was
   either soft-deleted (`deletedAt` set; clear it) or hard-deleted
   (re-insert from the snapshot extract).

### Leaked JWT secret

**Symptoms.** Tokens signed by an attacker pass `verifyAccessToken` /
`verifyRefreshToken`. May surface as anomalous logins, impossible
geo-pairs, or audit-log entries from accounts that didn't authenticate.

1. **Rotate `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` immediately.**
   Update the secrets manager and roll the API.
2. **Every active session is invalidated.** Users will be forced to
   sign back in. This is the correct outcome.
3. **Force a global session sweep:** delete every row in `sessions`
   where `revokedAt IS NULL`. Refresh-token reuse is rejected by the
   rotation logic; outright deletion is belt-and-braces.
4. **Audit.** Query `audit_logs` for anomalous events since the
   suspected leak window. Notify affected users per the operator's
   incident policy.
5. **Investigate root cause.** A leaked JWT secret almost always means
   the secrets manager itself or a build artifact was exposed. Rotate
   adjacent secrets (`STORAGE_*`, DB credentials) as a precaution.

### Leaked storage credentials

**Symptoms.** Anomalous bucket access (unexpected egress, unexpected
object listings, integrity violations on object-locked keys).

1. **Disable the leaked access key** at the cloud provider.
2. **Issue a new key**, push it to the secrets manager, bounce the
   API.
3. **Audit the bucket** for objects created or deleted with the leaked
   key (provider access logs). Restore deleted objects from
   version history.
4. **If `STORAGE_SIGNING_SECRET` may have leaked too**, rotate it.
   Outstanding signed URLs continue to validate until they expire;
   accept this for the window equal to
   `MEDIA_DOWNLOAD_URL_TTL_SECONDS` (default 300s) or block the leaked
   signature value at the proxy edge if available.
5. **Object lock saves you here.** Even with a leaked key, an attacker
   cannot purge object versions inside the lock window. If object lock
   was not configured, treat this as a partial data-loss incident and
   restore from cross-region replication.

### Region outage

**Symptoms.** Provider status page reports a region down. Both Mongo
and object storage are unreachable. The API in that region cannot serve
`/ready`.

1. **Confirm scope** via the provider status page and an independent
   check (e.g. external monitoring).
2. **Fail over** to the secondary region:
   - Promote the replicated Mongo cluster to primary.
   - Promote the replicated object-storage bucket to read-write.
   - Repoint `MONGODB_URI` and `STORAGE_BUCKET` / `STORAGE_REGION` in
     the secrets manager.
   - Spin up API instances in the secondary region.
3. **Run `npm run migrate`** before opening traffic — index parity is
   not guaranteed across regions if a recent migration was in flight
   during the outage.
4. **Accept the RPO.** The replicated cluster lags the primary by
   seconds (continuous backup) to minutes (cross-region replication).
   The last few messages and attachments may be missing. This is the
   stated RPO; do not improvise to chase a smaller number under
   pressure.
5. **Do not fail back** until the primary region is provably stable
   and the data delta has been reconciled (typically via a second
   restore once the primary is back).

---

## Readiness checks and startup/shutdown safety

The runtime already implements the safety properties prompt 18 requires.
This section documents what is wired so operators know what `/ready`
actually proves.

### Readiness

`GET /ready` ([`src/app.ts:115`](../src/app.ts#L115)) returns 200 only
when **both** Mongo (`isMongoReady`) and Redis (`isRedisReady`) report a
live connection. A 503 reliably drains the instance from the load
balancer.

- **Mongo readiness** = `mongoose.connection.readyState === 1`
  ([`src/db/mongo.ts:36`](../src/db/mongo.ts#L36)). A `disconnected`
  event flips it back; the reconnect attempt re-flips it.
- **Redis readiness** = the `ready` event fired and the client is
  non-null ([`src/db/redis.ts:50`](../src/db/redis.ts#L50)).
- **Object storage is intentionally not part of `/ready`.** Probing
  storage on every readiness check creates a coupling where a slow
  bucket trips the API as unhealthy. Storage failures degrade the
  attachment path only; text messaging, presence, and sockets continue.
  The trade-off is conscious: the [Object storage outage](#object-storage-outage)
  runbook is the recovery path for storage outages, not `/ready`.

### Liveness

`GET /health` reports process uptime and never touches a dependency.
This is the orchestrator's liveness probe — flapping dependencies must
not kill the process.

### Startup safety

- `src/config/env.ts` validates env at startup and **fails fast** in
  production if required secrets are missing, placeholders are still
  in place, CORS is wildcarded, or `STORAGE_PROVIDER=s3` is configured
  without bucket credentials. A misconfigured process never starts; it
  cannot serve a half-broken endpoint.
- `src/server.ts` connects to Mongo and Redis **before** the HTTP
  listener accepts traffic. If either fails, the startup promise
  rejects and the process exits non-zero.
- Migrations are not auto-run by the API. They are run explicitly via
  `npm run migrate` as part of the deploy. This avoids two replicas
  racing to create the same index on cold start.

### Shutdown safety

`SIGINT` / `SIGTERM` triggers the shutdown handler in
[`src/server.ts`](../src/server.ts). The sequence is:

1. **Stop new socket connections** via `shutdownSocketServer(io)`.
2. **Drain in-flight HTTP requests** via `httpServer.close()`.
3. **Close Mongo and Redis** cleanly.
4. **Force exit after 10s** if anything hangs (`setTimeout(..., 10_000)
   .unref()`). The orchestrator must give SIGTERM at least 10s before
   SIGKILL; otherwise drains are cut short.

Implication: rolling restarts are safe — the leaving replica drains
its socket and HTTP traffic before terminating.

---

## Testing and drills

| Drill | Cadence | What "pass" means |
| --- | --- | --- |
| **Backup integrity check.** Download a random recent `mongodump`, verify checksum, open archive header. | Weekly. | Checksum matches; archive opens; `mongorestore --dryRun` parses the manifest. |
| **Scheduled restore test.** Restore the previous-night snapshot into a throwaway cluster. Run the full integration suite against it. | Monthly. | Tests pass; `npm run migrate` reports no pending migrations. |
| **Disaster recovery drill.** Full region-out simulation: secrets-manager failover, Mongo promotion, bucket promotion, API stand-up in secondary region. | Quarterly. | API serves `/ready` 200 in the secondary region; smoke suite passes; rollback to primary is exercised at the end. |
| **Incident checklist review.** Walk through each runbook in this doc. Identify any step that has drifted from the code. Update the doc *before* updating the code. | Semi-annually. | All commands in the runbooks still work; all referenced file paths still exist. |
| **Secret rotation drill.** Rotate `JWT_ACCESS_SECRET` in staging, confirm graceful re-login behavior. | Quarterly. | No 5xx during the rotation window; users see a forced re-auth and nothing worse. |

Drills that pass silently get re-run; drills that pass with workarounds
get a follow-up ticket. A drill is only valuable if a *failure* would
have been caught in the dry run.

---

## Remaining production risks

The following are known gaps. They are recorded here because pretending
they don't exist is the only way they hurt in an incident.

- **Push fan-out is non-durable.** A process crash mid-push loses
  in-flight deliveries. Inbox state is correct; the device push for
  that one event is gone. Acceptable today because the inbox is the
  source of truth and clients poll. Becomes load-bearing if a future
  feature requires guaranteed push delivery — at that point, introduce
  a real durable queue (see [Queue recovery](#queue-recovery)).
- **No CDC / change stream consumer is shipped.** Operators who want a
  warm replica for analytics or search must build it. The recommended
  starting point is a Mongo change-stream consumer feeding a dedicated
  read replica, kept entirely outside the API process.
- **Encryption keys are not multi-region replicated by this
  service.** The secrets manager is. If the operator stages secrets
  through an intermediate KMS, the operator owns its replication
  posture. Document it in the deployment runbook.
- **The S3 storage provider is a placeholder.**
  [`src/modules/media/storage.ts`](../src/modules/media/storage.ts)
  ships an `UnconfiguredS3StorageProvider` that throws on every method.
  Wiring the real AWS SDK is a deployment-specific change. Until then,
  the only working provider is `memory`, which is dev-only and
  explicitly not durable. Treat "stand up production" as gated on
  wiring this provider.
- **Argon2 password hashes are not recoverable.** This is the design.
  A user who forgets their password must use the password-reset flow;
  there is no operator-side recovery and no shadow store of plaintext.
- **Object lock is provider-configured, not enforced here.** The
  application cannot tell whether the bucket has lock on. Verify it
  during the [readiness checklist](../README.md#production-readiness-checklist),
  not after an incident.

This document is descriptive of how the service is built today. Pair
every change to the runtime (new dependency, new datastore, new queue,
new secret) with an update to the relevant section here. A DR plan
that lags the code by a release is no plan at all.
