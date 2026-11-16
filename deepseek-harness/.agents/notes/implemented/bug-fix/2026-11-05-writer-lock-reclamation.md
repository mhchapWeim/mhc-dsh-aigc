# Agent Note: Writer lock reclamation keeps a live org bundle authorized

Status: implemented

English | [中文](2026-11-05-writer-lock-reclamation.zh.md)

## Problem

A desktop client could start with its organization (intranet) model bundle missing from the model list, and stay that way across restarts. The reported log line was an `atomic-write` timeout waiting for the writer lock at `C:\Users\<user>\.dsh\profiles\desktop\package.json.lock`.

Renaming that lock file by hand restored the client, which is the signature of an orphaned lock rather than a slow write.

Two independent defects combined into that outcome.

**The lock could never be recovered.** `withFileLock` created `<file>.lock` with `wx` and removed it in a `finally`, but no participant ever inspected whether the recorded owner still existed. The lock file already stored the creator's PID, yet nothing read it. The package documented this deliberately: *"A contender never deletes a lock … recovery is an operator action."* So any exit while holding the lock — a killed process, a crash, or a release that itself failed on a transient Windows handle — left a lock that failed every later writer of that file permanently. Release made this worse: `rm` ran inside the same `finally`, so a failing remove both discarded the operation's result and kept the lock.

**A lock timeout was then amplified into a de-authorization.** In `managed-sync`, a managed bundle's authorization is process-local and empty in a fresh process, so the first `loadProfileDirectory` skips it. Authorization is restored only by the poll loop calling `setBundleEnabled`, which needs the same lock. The plugin loop's `catch` treated every failure as a plugin failure: it recorded `Failed` and called `disable`, which calls `authorizeManagedBundle(dir, name, false)` before attempting to write. A lock timeout therefore withdrew the entitlement for a plugin that was intact on disk, and because `.aigc-plugin-state.json` still listed the package, every subsequent start repeated the sequence. `disable()` had the same shape — de-authorize first, attempt the write second — so a transient failure there could also unload a working bundle.

## Decision

- `WriterLockTimeoutError` (exported, `code: 'LOCK_TIMEOUT'`) replaces the bare `Error` for an expired wait, so callers that mutate durable state on failure can distinguish contention from a verdict on their own operation.
- A contender reclaims a lock only when the PID recorded in it is provably gone: a positive integer whose `process.kill(pid, 0)` reports `ESRCH`. A live PID, an unparsable or empty lock, and any other probe error all leave the lock in place, because a stolen live lock admits two concurrent writers.
- Reclamation never steals a lock that changed hands. The lock is renamed aside first, so this contender owns whichever inode it captured; the captured file is re-probed, and a lock whose owner is alive again is renamed back. If even that restore fails, the captured file is left behind rather than deleted.
- Release retries briefly, absorbs transient handles, and never throws. A failure here cannot replace a successful operation's result, and the next contender reclaims the lock once its owner is gone.
- In `managed-sync`, a `LOCK_TIMEOUT` no longer produces a `Failed` report, a `disable`, or a de-authorization. The plugin's previous status stands and the next poll retries, using a shorter `managedLockRetryMs` (default 5000 ms) than the ordinary `managedPollMs`. The identity-change check is still evaluated, because a lock conflict is not permission to skip it.
- `disable()` records the pre-call authorization and activation, and restores both when the write fails, so a failing unload cannot withdraw the entitlement of a bundle that is still enabled on disk.
- Activation restores the prior authorization when `setBundleEnabled` rejects, and the outer poll `catch` no longer calls `disableAll` for a lock conflict.

## Alternatives considered

**Delete any lock older than a fixed interval.** Age cannot distinguish a crashed owner from a writer that is merely paused, and a long pnpm operation legitimately holds this lock for minutes. The recorded PID is direct evidence; a timer is a guess that fails in the dangerous direction.

**Rely on the operator to delete the lock.** That is the shipped behavior and the reported failure: a desktop user cannot be expected to find `~/.dsh/profiles/desktop/package.json.lock`. It also does not scale — one affected machine per support ticket.

**Reclaim by unlinking the lock and retrying the exclusive create.** A plain `unlink` has no ordering guarantee: the previous holder can release between the check and the unlink, deleting a lock a third writer has just taken. Renaming aside makes the interaction observable instead of racy.

**Treat a lock timeout as a failed plugin.** This is what made a transient condition permanent. Contention is evidence about the profile writer, not about the bundle's integrity, so the correct reaction is to delay rather than to withdraw an entitlement.

**Retry the whole poll immediately on contention.** A tight retry against a lock held for the duration of a pnpm install would spin. A separate short delay keeps recovery prompt without competing with the holder.

## Verification

| Evidence | Covered behavior |
|---|---|
| [Lock suite](../../../../packages/util/atomic-write/tests/atomic-write.spec.ts) | Reclaims a lock whose recorded owner exited; leaves a live owner's lock and PID untouched; leaves an unreadable owner in place; reports `LOCK_TIMEOUT` with its path; releases after a throwing operation. |
| [Manager suite](../../../../packages/boot/plugin-manager/tests/manager.spec.ts) | A contended `setBundleEnabled` during a policy revision keeps the bundle authorized and loaded, reports no `Failed`, and resumes reporting `Active` once the lock frees. |

The reclamation test writes a real exited child's PID, because a fabricated out-of-range PID raises `ERR_INVALID_ARG_TYPE` on Windows rather than `ESRCH` and would not exercise the intended probe. The manager test injects `WriterLockTimeoutError` from the activation path; it is the regression that fails before the fix by observing `marketProbe` disappear and `isManagedBundleAuthorized` turn false.

## Consequences

- A lock whose PID was reused by an unrelated process is treated as live and times out, which is the safe direction; the file is reclaimed after that process exits.
- A writer that dies between `wx` and its PID write leaves a lock with empty content, which no contender reclaims. The window is a few microseconds and the alternative — reclaiming unreadable locks — would steal locks from paused holders.
- `LOCK_TIMEOUT` is now part of the package's public surface. Callers that previously matched on the message text can match the code instead.
- A poll skipped for lock contention reports nothing to the control plane, so the organization sees the previous status for that interval rather than a spurious failure. A permanently stuck lock therefore degrades to stale status plus warnings, not to a de-authorized plugin.
- Recovery from an already-orphaned lock on an affected machine is automatic on the next write attempt: no support action is required, and no manual file rename.
