# Messenger Node.js Prompt Pack

Use these prompts one by one with Claude. Start with the overview, then move through the numbered feature/module prompts.

Recommended order:

1. `messenger-nodejs-production-prompt.md`
2. `01-project-foundation.md`
3. `02-auth-and-sessions.md`
4. `02b-permissions-rbac.md`
5. `03-users-and-profiles.md`
6. `04-conversations-and-members.md`
7. `05-messages.md`
8. `05b-disappearing-messages.md`
9. `06-realtime-sockets-presence.md`
10. `07-media-and-attachments.md`
11. `07b-stories-status.md`
12. `08-blocking-reporting-moderation.md`
13. `09-search-notifications.md`
14. `10-admin-observability-audit.md`
15. `11-testing-deployment-hardening.md`
16. `12-data-model-indexes-migrations.md`
17. `13-contacts-invites-privacy.md`
18. `14-devices-push-notifications.md`
19. `15-api-contracts-versioning.md`
20. `16-privacy-retention-account-deletion.md`
21. `17-optional-e2ee-architecture.md`
22. `18-backup-restore-disaster-recovery.md`

For every prompt:

- tell Claude to inspect the current codebase first
- ask Claude to keep changes focused
- ask Claude to run lint, typecheck, and tests when available
- ask Claude to explain what changed and how to verify it

Do not ask Claude to build everything at once. Give one module prompt at a time.
