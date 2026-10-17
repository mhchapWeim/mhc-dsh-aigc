# Agent Note: Account-owned cloud conversation backups

Status: implemented

English | [中文](2026-10-15-account-owned-cloud-backups.zh.md)

## Problem

Moving to another computer requires conversation history and its referenced binary objects. Local migration directories alone do not provide account ownership or server-side access control.

## Decision

The Workspace Controller exports explicit Sessions or all stored history, including archived Sessions, with referenced attachments. Managed credentials remain in the Host. AIGC stores snapshots under the authenticated user and exposes metadata management separately from owner-only downloads. Administrator management does not grant download access to other users' history.

Restoration validates checksums and uses the existing migration receipts to create new local Sessions. Cloud restores set `archiveOriginals: false`, so matching source ids on the receiving device do not archive existing history. Local migration retains its original archive behavior.

## Alternatives considered

**Administrator downloads.** Rejected because the approved requirement restricts downloads to the owning user, even when an administrator manages metadata and deletion.

**Replacing local storage.** Rejected because the destination can already contain useful history. New Session ids retain that data and preserve a retryable migration receipt.

**Automatic synchronization.** Deferred because manual snapshots have explicit upload scope and require no cross-device conflict resolution.

## Consequences

Snapshots contain history and attachments, excluding project files, credentials and local settings. The 24 MiB snapshot limit bounds transfer and in-memory decoding; larger histories require selected batches. Active or unreadable Sessions reject an upload rather than silently producing an incomplete snapshot. Old absolute paths in message text remain unchanged. Immutable attachment objects can remain unreferenced after a failed restore; no existing object is overwritten.
