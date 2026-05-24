# End-to-end encryption — architecture plan

This document is an **architecture proposal**, not an implementation report.
No E2EE code has been written. Prompt 17
([`messenger-nodejs-production-prompts/17-optional-e2ee-architecture.md`](../messenger-nodejs-production-prompts/17-optional-e2ee-architecture.md))
explicitly forbids bolting encryption onto the existing plaintext pipeline
without a plan; this document is that plan. Pair it with the engineering
rules in [`AGENTS.md`](../AGENTS.md).

The current product ships **plaintext-at-rest, TLS-in-flight**. Messages
are stored as plain `text: string` in
[`src/modules/messages/message.model.ts`](../src/modules/messages/message.model.ts),
attachments are stored unencrypted in object storage with metadata in
[`src/modules/media/attachment.model.ts`](../src/modules/media/attachment.model.ts),
search runs a regex over the stored body
([`src/modules/search/search.service.ts`](../src/modules/search/search.service.ts)),
and push notifications include a body preview
([`src/modules/notifications/notification.service.ts`](../src/modules/notifications/notification.service.ts)).
**All four of those are incompatible with E2EE and have to change before
flipping any switch.** That is the central message of this document.

---

## TL;DR — recommended approach

- **Adopt the Signal protocol family.** It is the only design with serious
  cryptographic review, real-world deployments at scale, and open
  references. Do not invent a protocol.
  - **1:1 conversations:** X3DH (Extended Triple Diffie-Hellman) for session
    setup, Double Ratchet for ongoing message keys.
  - **Groups:** Sender Keys (one symmetric ratcheting key per sender per
    group) layered on top of pairwise Signal sessions for distribution. MLS
    (RFC 9420) is the next-generation alternative; recommended only if the
    project commits to a strict modern client floor.
- **The server stores ciphertext, public key bundles, and routing
  metadata. Nothing else.** Plaintext, search indexes built from plaintext,
  and notification body previews must move client-side.
- **Roll out behind a per-conversation flag, not a global one.** Existing
  plaintext conversations stay plaintext (they have to — old messages cannot
  be retroactively encrypted to keys that did not exist when they were
  written). New "encrypted conversations" are created with E2EE on from
  message 1.
- **Treat E2EE as a product change, not a feature toggle.** Search,
  moderation, abuse reporting, web sessions, notifications, multi-device
  sync, and account recovery all degrade or change. Some of them have to
  ship with replacement flows (client-side search; encrypted reports) and
  some are simply lost (server-side moderation of message bodies).
- **Phase the rollout.** Direct messages first, then groups, then
  attachments, then multi-device, then backup/recovery. Each phase has its
  own kill-switch and its own audit-log surface.

If the project is not willing to accept the trade-offs in
[Product trade-offs](#product-trade-offs), **do not start.** A half-secure
E2EE rollout (encryption on, but the server still sees previews or holds the
recovery key) is worse than honest plaintext-with-TLS: it misleads users
into trusting a property the system does not actually have.

---

## What changes in the existing app

Concrete files and contracts that need to move:

| Today | Under E2EE |
| --- | --- |
| `messages.text: string` plaintext body in [`message.model.ts`](../src/modules/messages/message.model.ts) | Replace with `ciphertext: Buffer`, `senderDeviceId`, `algoVersion`, per-recipient `headers[]`. Plaintext never reaches the server. |
| `messages.text` regex search in [`search.service.ts`](../src/modules/search/search.service.ts) | Server-side body search is **removed** for encrypted conversations. Search runs client-side over a locally-decrypted index. |
| `attachments` in [`attachment.model.ts`](../src/modules/media/attachment.model.ts) — bytes in S3, MIME/dimensions on the document | Add `encryptionKeyWrapped` (per-recipient, in the message envelope), `encryptedSizeBytes`, `nonce`. Strip server-side thumbnail/dimension fields for encrypted attachments — the server cannot read them. |
| Notification body preview built in [`notification.service.ts`](../src/modules/notifications/notification.service.ts) | For encrypted conversations, body and title become opaque (`"New message"`); the client decrypts on receipt and rewrites the notification locally on platforms that allow it (iOS Notification Service Extension, Android `NotificationListenerService`). |
| Message edit/redact rewrites the stored text in place | An edit becomes a new ciphertext envelope referencing the original message id; the server cannot rewrite ciphertext for a sender. |
| Moderator reads message body via `message:moderate` permission ([`02b-permissions-rbac.md`](../messenger-nodejs-production-prompts/02b-permissions-rbac.md)) | Removed for encrypted conversations. Replaced with **user-initiated encrypted reports** — see [Moderation](#moderation-and-abuse-reporting). |
| Disappearing-message cleanup job redacts text and stamps `expiredAt` ([`message.model.ts:107`](../src/modules/messages/message.model.ts#L107)) | Still runs — the job deletes the ciphertext envelope. Expiry is enforced on the server side because the server controls retention. The client also enforces local destruction. |
| Web client reads messages by re-using the access token | Web is the hardest surface for E2EE. Either ship a paired Web Worker that holds keys in IndexedDB with a passphrase, or **do not enable E2EE for web at launch.** Recommended: native-only at first. |
| Sessions in [`session.model.ts`](../src/modules/sessions/session.model.ts) authorize a *user* | Add a **device** layer (see [Device linking](#device-linking-and-multi-device)). Identity keys live per-device, not per-user. |

---

## Architecture topics

### Identity keys

Each **device** generates a long-term Curve25519 identity key pair on first
launch. The private key never leaves the device's secure store (Keychain on
iOS, Keystore on Android, OS keyring on desktop). The public key is
uploaded to a new `device_keys` collection (see [Data model](#data-model)).
A user with three devices has three identity keys; the server stores three
public keys; messages encrypted to "the user" are in fact encrypted
once-per-device.

The identity key is fingerprinted for verification — see
[Safety numbers](#safety-numbers-and-verification).

### Signed prekeys

Each device generates a Curve25519 **signed prekey**: a medium-lived key
pair (rotate every ~7 days) signed by the device's identity key. The signed
prekey lets a sender start a session with a recipient who is offline.
Servers store the public signed prekey and the identity-key signature over
it; clients verify the signature before using it. Rotation is a client
responsibility; the server is just a bulletin board.

### One-time prekeys

Each device pre-generates a batch (say 100) of **one-time prekeys** and
uploads the public halves. The server hands out exactly one per session
setup, then deletes it. When the pool drops below a threshold (e.g. 20),
the client refills it. If the pool runs dry, X3DH falls back to the signed
prekey alone — slightly weaker forward secrecy, but still functional.

### Session establishment (X3DH)

To start a 1:1 session with Bob's device, Alice's device:

1. Fetches Bob's **prekey bundle** from `GET /api/v1/e2ee/keys/:userId` —
   `{ identityKey, signedPrekey, signedPrekeySignature, oneTimePrekey? }`.
2. Verifies `signedPrekeySignature` against `identityKey`. Bails on
   mismatch.
3. Derives an initial shared secret from
   `DH(identityKeyA, signedPrekeyB) || DH(ephemeralA, identityKeyB) || DH(ephemeralA, signedPrekeyB) || DH(ephemeralA, oneTimePrekeyB)`.
4. Initializes a Double Ratchet from that shared secret.
5. Sends the first message; the message envelope includes Alice's identity
   public key and ephemeral public key so Bob can derive the same secret.

The server never sees any of the four DH inputs.

### Per-conversation keys (Double Ratchet)

Each message advances the **chain key** (KDF-forward) and, when a reply
arrives, advances the **root key** with a new DH exchange. This gives:

- **Forward secrecy:** compromising the key for message N does not reveal
  N-1.
- **Future secrecy / break-in recovery:** compromising a chain key does not
  reveal messages after the next DH ratchet step.

Each in-flight Double Ratchet session lives entirely on the two devices
involved. The server stores ciphertext only.

### Group encryption — Sender Keys

For a group of N members, encrypting every message to every recipient
separately is O(N) ciphertexts per message — fine for ≤ 32 members,
unworkable for hundreds. Use **Sender Keys**:

1. Each sender derives a *sender key* — a symmetric ratcheting key — and
   distributes it once to every other group member over pairwise Double
   Ratchet sessions.
2. Subsequent group messages are encrypted once with the sender's current
   sender key. Recipients ratchet forward locally.
3. On membership change (add/remove), every existing sender rotates their
   sender key and redistributes. Removal is what makes this expensive — a
   single ban requires every active sender to redistribute. Cap groups at
   a documented size (recommendation: 256) and expose the cost in
   product copy.

**MLS alternative.** MLS (RFC 9420) replaces Sender Keys with a tree-based
group key agreement that scales to thousands of members and handles
membership churn in O(log N). It also has formal security proofs. Choose
MLS only if (a) the client floor can ship a modern MLS stack on every
platform and (b) the team is willing to keep up with the RFC errata.
Otherwise Sender Keys is the lower-risk pick.

### Device linking and multi-device

There is no "the user's key." There is "the user's *current set of devices'*
keys." Linking flow:

1. New device generates its own identity key + prekeys, uploads to
   `device_keys`.
2. An existing trusted device of the same user authorizes the new device
   via a **device-link bundle**: a payload signed by the existing device's
   identity key, scanned via QR or short-lived code.
3. The server records the link in a `device_links` audit row. The link is
   surfaced to the user so they can see "Phone 14 Pro authorized
   2026-05-24" — same UX as Signal's linked devices list.
4. Every active session is restarted because the recipient set has
   changed. The first message after a link triggers a **safety-number
   change** banner on the other side.

Backfill of message history to the new device is **client-mediated**:
either pull from an encrypted backup (see [Encrypted backups](#encrypted-backups))
or accept that the new device starts blank. The server cannot help — it
holds ciphertext addressed to the old device's keys, and the new device
cannot decrypt it.

### Key rotation

- **Signed prekey:** rotated every ~7 days by the client. Server keeps the
  most recent two to absorb in-flight session setups.
- **One-time prekeys:** consumed on use, refilled by the client when the
  pool drops below threshold.
- **Identity key:** does **not** rotate. If it must (compromise), it is
  treated as a new device — a safety-number change for every contact.
- **Sender key:** rotated on every membership change and after a
  configurable max-messages or max-time threshold (e.g. 1000 messages or
  7 days), whichever first.

### Lost device handling

When a user marks a device as lost:

1. Server marks the device row `revoked: true` and removes its keys from
   the prekey bulletin board. New senders never establish sessions with
   the lost device again.
2. Every other device of the same user is notified to **drop the lost
   device from its sender-key recipient set** and rotate any sender keys
   that included it.
3. Counterparties see a safety-number change on the user's next message.

The server cannot retroactively pull back messages already delivered to
the lost device's ciphertext queue. Push the user toward a remote-wipe
flow via the device OS (MDM, Find My, Find My Device).

### Encrypted attachment keys

The body of the attachment is encrypted client-side with a random 256-bit
symmetric key + nonce. The ciphertext goes to object storage via the same
signed-URL flow already in
[`src/modules/media/storage.ts`](../src/modules/media/storage.ts) —
**no server changes required for upload**. The symmetric key is wrapped
once per recipient device using the existing Double Ratchet session and
shipped inside the message envelope (`attachments[i].keyWrapped[deviceId]`).
The server stores the wrapped keys but cannot unwrap any of them.

Server-side dimension/thumbnail enrichment is **dropped** for encrypted
attachments. The client must extract and ship its own metadata
(plaintext-leakage-bounded — e.g., file size and content type are visible;
EXIF should be stripped client-side before encryption).

### Encrypted backups

The hardest UX problem in any E2EE product. Choices, in order of
preference:

1. **No server-side backup at all.** Simplest. Strongest. Users who lose
   their last device lose their history. Signal shipped like this for
   years; it is defensible.
2. **Local device-to-device transfer.** New device QR-scans an old device,
   pulls the encrypted DB over LAN. Server is not involved.
3. **Passphrase-encrypted server backup.** User picks a high-entropy
   passphrase (or a generated 64-bit "recovery key"), client encrypts the
   message DB with a KDF (Argon2id, target ~1s on a mid-tier phone) and
   uploads the ciphertext blob to a new `encrypted_backups` collection.
   The server cannot decrypt without the passphrase. **Lost passphrase =
   lost history** — make this clear in UX and require the user to confirm
   they have stored the recovery key.
4. **HSM-backed key escrow.** A trusted server-side HSM (or external KMS)
   holds the unwrap key; recovery is gated by SMS/email + rate-limited
   guess attempts. *Do not do this without a written legal/operational
   review* — it is the design WhatsApp uses, and the trade-offs are real:
   the user no longer has cryptographic sole custody of their messages.

Recommend (1) or (2) for launch. (3) is acceptable if backups are a hard
product requirement. (4) is off the table without explicit sign-off.

### Safety numbers and verification

Each pair of devices derives a **safety number** by hashing their two
identity public keys together. The number is rendered as a 60-digit
decimal string or a QR code. Two users can verify out-of-band that their
safety numbers match, which proves no third party (including the server)
inserted a key.

The client must surface a **safety-number change** banner whenever a
counterparty's identity key changes. This is the only practical defence
against a malicious server swapping in its own key during X3DH.

### Server-visible metadata

Be honest about this. Even with full E2EE, the server still sees:

- Who is in which conversation (`conversation_members`).
- Message timestamps and rough sizes.
- Whether a message has attachments (and the encrypted size of each).
- IP address at connect time (sockets).
- Device fingerprints (platform, app version) from
  [`device.model.ts`](../src/modules/devices/device.model.ts).
- Read-receipt timing (delivery and read receipts are still server-routed).
- Group membership changes.

Mitigations (all optional, all expensive):

- **Sealed sender.** Sender identity is encrypted inside the envelope so
  the server only learns the recipient. Breaks easy abuse-rate-limiting;
  needs delivery tokens to compensate.
- **Padding to fixed-size buckets.** Hides message length up to a bucket
  boundary at the cost of bandwidth.
- **Cover traffic.** Out of scope at this scale.

Document what the server *can* see in the privacy policy. Hiding the
metadata leakage is what breeds the "Signal vs. Telegram vs. WhatsApp"
arguments — be the boring honest one.

---

## Server responsibilities

The server's job shrinks dramatically. It is responsible for:

- **Routing ciphertext.** `POST /api/v1/conversations/:id/messages` accepts
  an envelope `{ recipientDeviceId, ciphertext, header, attachmentRefs[] }`
  per recipient device. The server fan-outs to each recipient's connected
  sockets and persists for offline delivery, same as today.
- **Holding the key directory.** `device_keys` collection — public identity
  keys, signed prekeys, one-time prekey pool. `GET /e2ee/keys/:userId`
  hands out a bundle. `POST /e2ee/keys/refill` accepts new one-time
  prekeys.
- **Delivery receipts.** Receipts in
  [`message.test.ts`](../src/modules/messages/message.test.ts) move into
  the encrypted layer — receipts are themselves encrypted Double Ratchet
  messages from the recipient's device. The server routes them but does
  not interpret them. (The server *can* keep a separate plaintext
  "delivered/read" pointer per message+recipient for UI purposes; this is
  metadata leakage but acceptable.)
- **Retention.** Disappearing-message expiry still runs as a server-side
  job that drops the ciphertext envelope. Client-side enforcement is
  defence-in-depth.
- **Audit.** Device add/remove, safety-number changes, recovery-key resets
  all go into [`src/modules/admin`](../src/modules/admin) audit logs.
  These rows contain identifiers and hashes only, never plaintext.

The server is **not** responsible for:

- Reading message bodies.
- Building search indexes over message bodies.
- Generating notification body previews.
- Generating attachment thumbnails or dimension metadata.
- Server-side message edits (the body cannot be rewritten by anyone but
  the sender).

---

## Data model

New collections. None of these displace existing ones — they are additive.

```txt
device_keys
  _id
  userId           ObjectId, indexed
  deviceId         ObjectId (matches Device._id in device.model.ts)
  identityKeyPub   binary, Curve25519, 32 bytes
  identityKeyFprint string, hex SHA-256 of identityKeyPub (for safety numbers)
  signedPrekeyId   int
  signedPrekeyPub  binary
  signedPrekeySig  binary, Ed25519 sig over signedPrekeyPub by identityKey
  signedPrekeyAt   Date
  oneTimePrekeys   subcollection / array of { id, pub } — consumed on use
  createdAt, updatedAt
  unique index on (userId, deviceId)

device_links
  _id
  userId
  authorizedByDeviceId
  newDeviceId
  authorizedAt
  revokedAt
  (audit trail; never deleted, just revoked)

encrypted_messages
  _id
  conversationId
  senderId, senderDeviceId
  recipientDeviceId       — one row per recipient device per logical message
  envelopeCiphertext      Buffer
  envelopeHeader          Buffer  (DH ratchet header, message counter)
  algoVersion             int     (envelope format version; never reuse)
  attachmentRefs          [{ attachmentId, keyWrapped, nonce }]
  expiresAt, expiredAt    Date    (disappearing message bookkeeping; same shape as today's messages collection)
  createdAt
  index: (conversationId, _id desc) — same pagination shape as plaintext messages
  index: (recipientDeviceId, deliveredAt) — for "what does this device still need to pick up"
  index: expiresAt sparse — disappearing cleanup

encrypted_attachments
  Same shape as today's attachments collection EXCEPT:
  - storageKey points at the encrypted blob
  - mimeType is "application/octet-stream" from the server's view
  - width/height/durationSeconds removed
  - encryptedSizeBytes added
  - thumbnail fields removed
  No server-side enrichment.

encrypted_backups   (only if backup option (3) above is chosen)
  _id
  userId
  ciphertextStorageKey  — in object storage
  kdfParams             — Argon2id params used; lets us migrate later
  sizeBytes
  createdAt, lastRestoredAt
```

**Migration story.** The existing
[`messages`](../src/modules/messages/message.model.ts) and
[`attachments`](../src/modules/media/attachment.model.ts) collections stay
exactly as they are. They serve **legacy plaintext conversations forever**;
encrypted conversations write to the new collections. The
`conversations` document gains an `encryption: 'plaintext' | 'e2ee-v1'`
discriminator (default `plaintext`); message-send code routes on it.

A conversation can never be upgraded from `plaintext` to `e2ee-v1`. The
plaintext history is plaintext; you cannot retroactively encrypt to keys
that did not exist. A user who wants encryption with the same person
starts a new conversation.

---

## Product trade-offs

### Search

- Today: regex over `messages.text`
  ([`search.service.ts:153-161`](../src/modules/search/search.service.ts#L153-L161)).
- Under E2EE: server cannot index ciphertext. Options:
  - **Client-side search index.** Client maintains a local searchable index
    keyed by message id; query runs locally. Loses cross-device parity
    unless the index syncs (over E2EE, expensive).
  - **Encrypted searchable indexes (PSI / SSE).** Active research area;
    no battle-tested open-source implementation. Not recommended.
- **Recommendation:** drop server-side body search for encrypted
  conversations; ship client-side search; document the limitation.

### Moderation and abuse reporting

- Today: moderators with `message:moderate` permission can read any
  message; reports surface the offending body in the admin UI.
- Under E2EE: moderators cannot read ciphertext.
- **Replacement flow:** when a user files a report, the client attaches a
  **plaintext copy of the offending message(s)** to the report, signed by
  the reporting user's device. The server receives the plaintext copy +
  signature, stores it in the report row, and surfaces it to moderators.
  This is the standard E2EE moderation pattern (used by WhatsApp / Signal).
  - The reporter is the **only** party who can hand the body to the server.
    The accused user's own copy never leaves their device.
  - Document this in the privacy policy: "Reporting a message hands the
    server a copy of that message."
- Proactive content moderation (scanning all messages for CSAM, etc.) is
  **not possible** under E2EE without breaking the security guarantee.
  Do not ship a server-side scan-then-encrypt shim — it is the worst of
  both worlds. If proactive scanning is a regulatory requirement in any
  target market, E2EE is not viable for that market.

### Password reset and key recovery

- Today: password reset re-establishes auth; message history is fine.
- Under E2EE: the encryption key is not derived from the password.
  Password reset does not recover messages.
- **Recovery paths:**
  - From another linked device (transfer flow).
  - From an encrypted backup (passphrase-protected).
  - Otherwise: history is gone. The user can keep their account and
    contacts but starts blank.
- Document this loudly. "If you lose all your devices and your recovery
  key, your message history cannot be recovered. This is intentional."

### Multi-device

- Today: account = user. Sessions are per-login.
  ([`session.model.ts`](../src/modules/sessions/session.model.ts).)
- Under E2EE: account = user, but messages are addressed to *devices*.
  Adding a device requires authorizing it from an existing one
  (see [Device linking](#device-linking-and-multi-device)).
- New device starts with no history unless backup or device-to-device
  transfer is used.
- Linking N devices means every outgoing message is encrypted N times
  (once per recipient device). Cap the device count per user at e.g. 4 to
  keep the fan-out bounded.

### Push notification preview

- Today:
  [`notification.service.ts`](../src/modules/notifications/notification.service.ts)
  builds a body preview from the message text (truncated to
  `NOTIFICATION_BODY_PREVIEW_MAX_LENGTH`).
- Under E2EE: the server cannot read the body. Push payloads become
  generic: `{ "title": "Messenger", "body": "New message", "data": { "conversationId": "...", "ciphertext": "..." } }`.
- The mobile client uses **iOS Notification Service Extension** /
  **Android `RemoteMessage` handler** to decrypt locally and rewrite the
  notification with the real body before display.
- Web push cannot rewrite notifications on most browsers — accept generic
  push on web.

### Backups

- See [Encrypted backups](#encrypted-backups). Pick one of the four
  options up front; do not ship "we'll add backups later" because the
  decision affects key management from day one.

---

## Implementation phases

Each phase is independently shippable and ends with a working product. Do
not start phase N+1 until phase N has been in production for two release
cycles without rollbacks.

### Phase 0 — design lock-in

- Pick MLS vs. Sender Keys.
- Pick backup option (1)–(4).
- Pick web-client policy (E2EE on web at launch yes/no).
- Get privacy-policy and legal review of the moderation/recovery flows.

**Done criterion:** signed-off design doc. No code.

### Phase 1 — device layer

- Add `device_keys`, `device_links` collections and the prekey-bulletin-board
  endpoints (`/e2ee/keys/:userId`, `/e2ee/keys/refill`).
- Add device identity-key generation and storage on the client.
- Add the device-link UX (QR / short code).
- **Do not enable encryption yet.** The plaintext send path stays.
- Audit log every device add, link, and revoke.

**Done criterion:** every active user has at least one device row with a
healthy prekey pool; safety-number rendering works end-to-end; nothing in
the message pipeline changed.

### Phase 2 — 1:1 encrypted conversations

- Add `encryption` discriminator to `conversations`.
- Add `encrypted_messages` collection.
- Implement X3DH session setup and Double Ratchet on the client.
- Implement the server fan-out: one envelope per recipient device.
- Notification payloads go generic for encrypted conversations.
- Search is disabled for encrypted conversations in the UI.

**Done criterion:** two users with matching device floors can have an
end-to-end encrypted 1:1 conversation that survives offline, disappearing
messages, and message editing.

### Phase 3 — encrypted attachments

- Reuse the existing signed-URL upload flow
  ([`src/modules/media/storage.ts`](../src/modules/media/storage.ts));
  client encrypts before upload.
- Drop server-side thumbnail / dimension extraction for encrypted
  attachments.
- Validate that the existing TTL-based orphan-cleanup job
  ([`messenger-nodejs-production-prompts/07-media-and-attachments.md`](../messenger-nodejs-production-prompts/07-media-and-attachments.md))
  still works on encrypted blobs (it should — it operates on the document,
  not the content).

**Done criterion:** encrypted attachments round-trip; thumbnails render
client-side; storage costs are tracked against the encrypted size.

### Phase 4 — group encryption

- Implement Sender Keys (or MLS, per phase-0 decision).
- Implement the membership-change rotation flow.
- Cap encrypted-group size at the documented limit.

**Done criterion:** an encrypted group with 32 members handles
add/remove/leave without leaking messages to ex-members.

### Phase 5 — backup / recovery

- Implement whichever backup option phase 0 picked.
- If passphrase-based, ship the recovery-key generation UX (and the
  scary-but-correct "we cannot recover this for you" copy).

**Done criterion:** a user who reinstalls the app can restore history
exactly when expected and fails to restore history exactly when expected.

### Phase 6 — operational hardening

- Add metrics for: prekey-pool depletion rate, safety-number-change rate,
  envelope-fan-out p99 latency, backup-restore success rate.
- Add admin alerts for sudden spikes (could indicate key-swap attack).
- Run an external cryptographic audit before public launch.

**Done criterion:** external audit report; no high-severity findings open.

---

## Required client changes

- Curve25519 + Ed25519 + AES-256-GCM + HKDF + HMAC-SHA256 primitives.
  Use libsignal-client (Rust, well-reviewed) via FFI on iOS / Android /
  desktop. Avoid hand-rolling.
- Secure storage of identity-key private bytes (Keychain / Keystore /
  OS keyring). Never in plain app sandbox storage.
- Local message database becomes the source of truth for plaintext
  history. Existing UI assumptions that "the server has my messages" must
  change.
- Client-side search index over the local message DB.
- iOS Notification Service Extension and Android push-receiver code to
  decrypt push payloads.
- Device-link UX (QR scan + safety-number confirmation).
- Backup/restore UX with the recovery-key flow.

## Required backend changes

- New `/e2ee/keys/*` endpoints (prekey bundle fetch + one-time prekey
  refill).
- `device_keys`, `device_links`, `encrypted_messages`, optionally
  `encrypted_backups` collections.
- `conversation.encryption` discriminator and routing in the message-send
  controller.
- Notification fan-out: drop the body preview for encrypted conversations;
  ship the ciphertext in the push payload's `data` field.
- Search service: refuse to index `encrypted_messages`; return empty for
  encrypted-conversation queries with a `SEARCH_UNAVAILABLE_E2EE`
  error code (add to
  [`docs/api/ERROR_CODES.md`](api/ERROR_CODES.md)).
- Moderation service: switch to the "reporter ships a plaintext copy"
  flow; admin UI updates to reflect that reports for encrypted
  conversations only contain what the reporter chose to share.
- Audit log additions: device-add, device-link, device-revoke,
  safety-number-change, backup-create, backup-restore.
- Disappearing-message cleanup job ([`message.model.ts:95`](../src/modules/messages/message.model.ts#L95))
  extended to sweep `encrypted_messages` too.
- API versioning: this is a **major-version bump** per
  [VERSIONING.md](api/VERSIONING.md) (response shapes change for the
  encrypted message envelope, the notification preview field disappears,
  the search endpoint gains a new error code). Bump to `/api/v2`.

---

## Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Server is the key directory — a malicious server can swap keys during X3DH | High | Safety-number verification UX; alert on safety-number change. Cannot be eliminated by cryptography alone. |
| Lost recovery key = lost messages | High | UX must require the user to confirm they have stored the recovery key. Document loudly. |
| Group-membership churn invalidates sender keys constantly | Medium | Cap group size; rate-limit add/remove; consider MLS if churn is high. |
| Push payload size limits (APNs ~4KB) too small for some ciphertexts | Medium | Drop oversized push payloads to a generic "New message" + force a fetch on app open. |
| Server-side moderation cannot scan E2EE bodies | Medium | User-initiated report flow; document the moderation gap. |
| Web client cannot safely hold long-term keys in a browser | Medium | Native-only at launch; revisit with hardware-backed WebAuthn-derived keys later. |
| Bug in client crypto library exposes plaintext | High | Use libsignal-client; do not hand-roll; subscribe to upstream advisories; cryptographic audit before launch. |
| Half-migration: some clients on E2EE-aware build, some not | High | Per-conversation flag, not global. New encrypted conversations only created when both sides advertise capability. Old clients see "this conversation requires a newer app version" placeholder. |
| Server-side `message.text` regex search PII leak still exists for legacy plaintext convos | Low | Existing behavior — no regression. Document that legacy plaintext convos are not E2EE. |
| Account-deletion sweep ([`docs/PRIVACY_RETENTION.md`](PRIVACY_RETENTION.md)) does not know about `encrypted_messages` | High at rollout | Extend the finalize-deletion job to also clean encrypted message rows when the user is deleted. |

---

## Tests needed

Test categories — *to be implemented in phase order alongside the feature
they cover*. None of these exist today.

### Cryptographic correctness
- X3DH session setup produces matching shared secrets on both sides.
- Double Ratchet derives the same message keys forward and backward.
- Tampering with the ciphertext / header fails decryption (negative test).
- Tampering with the identity-key signature on a signed prekey is
  rejected.
- One-time prekey is consumed exactly once (server-side test).

### Session lifecycle
- Out-of-order message delivery still decrypts (Double Ratchet's
  skipped-message support).
- A message sent while the recipient was offline decrypts on reconnect.
- Adding a device triggers a safety-number change on every counterparty's
  next read.
- Revoking a device removes its keys from the prekey bulletin board.

### Group encryption
- Sender Keys: a removed member cannot decrypt subsequent messages.
- Sender Keys: an added member cannot decrypt prior messages.
- Adding 32 members to a group and sending one message produces O(1)
  ciphertext, not O(32).

### Server contract
- `POST` to a conversation with `encryption: 'plaintext'` and an E2EE
  envelope is rejected (and vice versa).
- `GET /e2ee/keys/:userId` returns a bundle whose `signedPrekeySig`
  verifies under the returned `identityKey`.
- Refilling one-time prekeys is idempotent and rate-limited.

### Negative auth / authorization
- A user not in the conversation cannot fetch its envelopes (same
  resource-level checks as today — see
  [`src/modules/permissions/authorization.ts`](../src/modules/permissions/authorization.ts)).
- A user cannot publish keys for a device that isn't theirs.

### Product flows
- Disappearing-message expiry deletes the encrypted envelope.
- A reported message arrives in the moderation queue with the
  reporter-supplied plaintext copy and signature.
- Notification fan-out for an encrypted conversation produces a generic
  `body` and a non-empty `data.ciphertext`.
- Search endpoint returns `SEARCH_UNAVAILABLE_E2EE` for an encrypted
  conversation.
- Account deletion finalization removes the user's `device_keys` rows and
  the encrypted-message rows where they were the sole recipient.

### Operational
- Prekey-pool-depletion alert fires when a user's one-time prekeys drop
  below threshold.
- Safety-number-change-rate alert fires on a spike (defence against a
  rogue server swapping keys).

---

## What this document does **not** decide

Items deferred to a future design pass once Phase 0 begins:

- Exact wire format for the encrypted envelope (CBOR vs. Protobuf vs.
  Cap'n Proto).
- Whether to ship sealed sender at launch.
- Whether to expose the user's safety number numerically, as a QR, or
  both.
- The exact backup KDF parameters (Argon2id memory/iterations).
- Cross-account portability of message history (probably not — Signal
  doesn't either).

Each of these is a tractable follow-up given the architecture above.
None of them block phase 0 sign-off.

---

## References

- Signal protocol specs: <https://signal.org/docs/>
- MLS RFC 9420: <https://datatracker.ietf.org/doc/html/rfc9420>
- libsignal-client: <https://github.com/signalapp/libsignal>
- AGENTS.md — engineering and security rules this project follows.
- Prompt 17 source:
  [`messenger-nodejs-production-prompts/17-optional-e2ee-architecture.md`](../messenger-nodejs-production-prompts/17-optional-e2ee-architecture.md).
