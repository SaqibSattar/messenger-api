# Prompt 17: Optional End-To-End Encryption Architecture

You are an expert secure messaging architect.

Do not implement end-to-end encryption immediately unless the user explicitly asks for it. First produce an architecture plan and impact analysis.

## Goal

Design an optional E2EE architecture for the messenger app and explain what must change before implementation.

## Important Warning

End-to-end encryption changes the whole product. It affects:

- message search
- moderation
- abuse reporting
- multi-device sync
- key backup/recovery
- push notifications
- attachments
- analytics
- server-side previews
- legal/compliance workflows

Do not bolt E2EE onto an existing plaintext architecture casually.

## Architecture Topics

Cover:

- identity keys
- signed prekeys
- one-time prekeys
- session establishment
- per-conversation keys
- group encryption strategy
- device linking
- key rotation
- lost device handling
- encrypted attachment keys
- encrypted backups
- safety numbers or verification
- metadata that remains visible to the server

## Data Model Guidance

Potential collections:

```txt
user_key_bundles
device_keys
conversation_key_state
encrypted_messages
encrypted_attachments
```

## Server Responsibilities

Server may store and route:

- encrypted message ciphertext
- encrypted attachment metadata
- public key bundles
- delivery receipts
- encrypted sender metadata where supported

Server should not be able to read message plaintext.

## Product Tradeoffs

Explain:

- message search limitations
- moderation limitations
- password reset/key recovery limitations
- multi-device complexity
- push notification preview limitations
- backup implications

## Deliverable

Produce:

- recommended approach
- implementation phases
- required client changes
- required backend changes
- data model changes
- risks
- tests needed

## Done Criteria

- no half-secure implementation
- architecture is clear
- tradeoffs are documented
- next implementation prompts can be created from the plan
