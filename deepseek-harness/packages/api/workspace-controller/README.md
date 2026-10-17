---
description: "Host and Client workspace control: mutate workspace navigation and follow its complete projection."
kind: "package-reference"
---
# Workspace Controller

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-api-workspace-controller` owns the Host `ctx.workspaceController` service and the generated Client `ctx.remote.workspace` namespace. Its Remote methods create, rename, remove, and reorder Workspaces, reorder Sessions within a Workspace, archive and unarchive Sessions from Workspace navigation, and follow the complete Workspace projection. Use it through API Gateway when a Client must change or follow Workspace navigation. The package also owns `ctx.directoryPickerController` and the generated `ctx.remote.directoryPicker` namespace, because the directory-picking seam it carries is abstract and never a Loader entry of its own.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

<a id="data-repair-and-copy-migration"></a>
### Data repair and copy migration

Cloud backup methods require a signed-in managed backend. `uploadCloudBackup()` exports all stored Sessions, including archived history, or explicit `sessionIds`; unreadable or active Sessions reject the upload. The snapshot includes referenced files and images, excludes project files, credentials and local settings, and is limited to 24 MiB. `cloudBackups(page)` and `deleteCloudBackup(id)` operate on the signed-in account. `restoreCloudBackup({ id, targetPath })` verifies the snapshot and attachment checksums, creates new Sessions under a local destination, and retains existing Sessions without archiving them. A partial restore returns a retryable local migration receipt. Old absolute paths inside messages remain unchanged; cloud backups are manual snapshots, not automatic synchronization.

`dataStatus()` checks directories and stored Session references and lists saved migration receipts. Local data operations remain available while signed out. `repairDirectory()` recreates a missing directory, without claiming to restore deleted files. `forgetMissingSessions()` removes references only when persistence confirms an artifact is absent; unreadable artifacts and live Sessions are retained.

`previewMigration()` saves selected history to `$DSH_HOME/migrations/<id>/sessions.json`, with a checksum and receipt. Select a registered Workspace, individual Session ids, an old JSONL sessions root, or a backup directory. Optional workspace files are backed up with SHA-256 checksums, including empty directories. Historical format conversion runs against a copied sessions root. Running Sessions are skipped with an explicit warning.

`commitMigration({ migrationId })` copies files without overwriting conflicts, creates new Session ids with the destination cwd, verifies the copied logs, and attaches them to the destination Workspace. Source logs, source directories, credentials, and plugins remain unchanged. Successfully copied source Sessions are archived out of the default list; failures remain visible. Destination title checkpoints are persisted before registration. Resuming a completed receipt synchronizes titles and source archives without copying again. Retries use the same target ids; a partial copy remains visible in the receipt. Missing or corrupt sources are reported individually. Session messages retain old absolute paths, and external attachment blobs are not included in a sessions-root backup. Restore those blobs separately when importing history from another machine. No model call runs during migration; future requests use the migrated history.

The Host controller serializes mutations whose correctness depends on current registry state and throws `RemoteError` with a stable error code for expected failures. Its `follow()` stream synchronously attaches to durable Workspace changes, emits one complete baseline first, then emits ordered `upsert`, `remove`, `order`, `archived`, and `pinned` increments. Archive and pin sets are Session id arrays, with the most recently pinned id first in the pin array. A reconnect starts another generation with a replacement baseline, so consumers do not depend on receiving every increment while disconnected. `archiveSession` without `stopActivity` refuses a Session with running work as `workspace/session-active`, whose details list that work by family (`turn`, `subagent`, `job`, `schedule`) with item ids and labels; with `stopActivity: true` the registry's providers stop the work first and the response arrives once the archive set is durable, while the stops settle in the background.

The Client entry provides `ClientWorkspaceModel` and `createWorkspaceStateStream()`. The model owns Workspace rows, registry order, archived and pinned Session identities, unary mutation echoes, and stream/unary race resolution. A newer Host row wins by `updatedAt`; a committed stream order outranks an older unary response; a removed Workspace id cannot be resurrected by delayed data. Pin snapshots change only when their identities or order change. The package exposes framework-neutral snapshots and subscriptions, leaving navigation policy and React hooks to the UI owner. `WorkspaceController.archiveSession(sessionId, { stopActivity })` throws `WorkspaceArchiveError` with the Host's `rpcError`, so a surface can tell the running-work refusal from a missing Session or a carrier fault and offer to stop the work.

<a id="first-use-workspace"></a>
### First-use Workspace

`workspace.initializeDefault({ directoryName, title })` returns the durable default Workspace; the Client service exposes the same request as `workspaces.initializeDefault(request, signal?)`. The [Workspace Client](../../client/ui-workspace/README.md) resolves these names from its startup language. The Host places the directory under its account's `<Documents>/deepseek-harness`, including on remote Web hosts. The directory name must be one non-blank segment without separators, colon, NUL, surrounding whitespace, or a trailing dot; the title must be non-blank. OS filename restrictions also apply. Linux system lookup requires `xdg-user-dir` with an enabled Documents directory; hosts without it must configure `documentsDirectory` or use the folder picker.

The [Workspace registry](../../workspace/workspace/README.md#first-use-workspace) owns eligibility, directory creation, and durable initialization. An existing default Workspace is returned without another Documents lookup; request names do not rename it. Ineligible first use returns `undefined`, so startup can leave directory selection to the user. Invalid names reject with `gateway/bad-request`; lookup and creation failures use standard Remote error handling. Initialization creates no Session and sends no message.

| Configuration | Default | Purpose |
| --- | --- | --- |
| `defaultDirectory` | Unset | Exact first-use workspace directory; bypasses Documents lookup |
| `documentsDirectory` | System Documents directory | Fully qualified Host directory override |
| `documentsLookupTimeoutMs` | `10000` | Positive maximum duration of OS directory lookup, in milliseconds |
| `cloudRequestTimeoutMs` | `120000` | Positive maximum duration of one cloud backup HTTP request, in milliseconds |

Documents lookup holds the registry mutation queue, so other Workspace mutations, including registration of a picked directory, can wait up to `documentsLookupTimeoutMs`. Cancellation can stop the lookup; after resolution succeeds, it does not roll back creation or registration.

-----

<a id="model-experience"></a>
## Model Experience

None, as Workspace organization is browser and Host control state and registers no prompt, tool, or session event.

#### KV Cache effect

No direct effect; Workspace mutations do not alter model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- `follow()` replaces the whole projection after reconnect and has no durable cursor or incremental catch-up protocol.
- Process-local deletion markers prevent delayed data from reviving a removed Workspace only for the lifetime of the Client model.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Workspace Registry owns persistence; every stream generation is a full projection.
