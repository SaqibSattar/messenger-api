# Prompt 18: Backup, Restore, And Disaster Recovery

You are an expert production reliability engineer.

Inspect the backend architecture, database, Redis usage, object storage, queues, and deployment docs before changing anything.

## Goal

Create a practical backup, restore, and disaster recovery plan for a production messenger backend.

## Required Work

- document MongoDB backup strategy
- document MongoDB restore process
- document object storage backup/retention expectations
- document Redis persistence expectations
- document queue recovery behavior
- document secrets backup/rotation expectations
- document incident recovery steps
- add readiness checks if missing
- add startup/shutdown safety if missing
- add runbooks for common failures

## Backup Scope

Back up:

- MongoDB data
- object storage media
- encryption keys if E2EE/storage encryption exists
- environment/secrets through a secure secrets manager process
- deployment configuration

Do not treat Redis as the source of truth unless explicitly designed that way.

## Restore Requirements

Document:

- point-in-time restore expectations
- restore order
- how to restore database
- how to restore media
- how to validate restored data
- how to handle partially processed queue jobs
- how to rotate compromised secrets

## Disaster Scenarios

Add runbooks for:

- MongoDB outage
- Redis outage
- object storage outage
- queue worker failures
- accidental data deletion
- leaked JWT secret
- leaked storage credentials
- region outage

## Testing And Drills

Recommend:

- scheduled restore test
- backup integrity check
- disaster recovery drill
- incident checklist review

## Done Criteria

- backup/restore docs exist
- operational assumptions are explicit
- readiness checks match dependencies
- failure modes have runbooks
- remaining production risks are clearly listed
