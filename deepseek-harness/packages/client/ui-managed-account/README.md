---
description: "Organization sign-in step for the dsh web client: the credential form and CAS browser flow a managed-backend deployment shows before its models are usable."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-managed-account

English | [中文](README.zh.md)

## Summary

Use AIGC or SSO authentication in a managed deployment and open Data and migration for account-owned cloud backups or local recovery. Upload all history or selected Sessions, then restore into a local directory on another computer. Local repair remains available while signed out; cloud commands require authentication. Restoring creates new Sessions and preserves existing history.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

The account menu also exposes **Data and migration** while signed out. It previews a backup before copying Sessions and optional workspace files, imports old sessions roots, restores migration backups, recreates missing directories, cleans confirmed-missing references, and resumes saved migration receipts. These operations use the [Workspace Controller](../../api/workspace-controller/README.md#data-repair-and-copy-migration). A local Workspace failure shows a repair notice while preserving the verified organization identity.

A deployment that routes models through `@deepseek-ai/dsh-llm-managed-backend` serves no model until the user has an organization session. This package contributes a password onboarding step and an account menu with separate AIGC authentication and SSO authentication entries. AIGC authentication opens the username/password form; SSO authentication starts the platform's CAS browser flow directly. The step disappears when the managed backend reports a signed-in user, and an installation without that backend never sees it.

Session selection supports Select all / Clear selection for readable, unarchived Sessions in the selected workspace. Completed receipts expose Sync migrated session display to repair title caches and hide copied originals without copying history again. Migration completion refreshes the Session list.

The data dialog presents account-owned cloud backups first: upload all history or selected Sessions, browse dated snapshots, download and restore into a local directory, or delete a snapshot. Signed-out users retain access to the expandable local repair tools. Cloud commands use the [Workspace Controller](../../api/workspace-controller/README.md#data-repair-and-copy-migration); restoring refreshes the Session list and retains the local retry receipt.

The step mounts through `settings.onboarding`, so the settings shell shows it as an ordered first-run step. The shipped Web bundle enables this plugin when `DSH_MANAGED_BACKEND_URL` is configured. Once mounted, the step asks the managed backend for its current sign-in state:

- **No managed backend** — the step completes itself immediately and renders nothing if the plugin is mounted separately without the adapter.
- **A stored session** — the step completes itself; the user is already signed in.
- **No session** — the step keeps ownership and shows the sign-in card.

The account menu offers **AIGC authentication** and **SSO authentication** alongside Settings. The AIGC card submits the entered username and password and contains no SSO button. Selecting SSO starts a CAS attempt directly, opens the platform's verification page in the default browser, and polls every `intervalSeconds` until confirmation or a five-minute deadline. Its separate waiting card contains no credential fields; Cancel closes it and retires the poll loop without ending the attempt on the platform. Failed or expired attempts offer Retry. A late poll response after cancellation cannot complete the step.

A dismissed card is a skip: the step hands ownership to the next onboarding entry, and the user still has no session. The next launch asks again.

### Failure copy

Every refusal renders one sentence: wrong credentials, a CAS attempt that expired or failed, and an unreachable backend each have their own copy. The copy distinguishes "the backend could not be reached" from "the backend rejected these credentials", because the two need different user action.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser half reads and writes through the `credentials` Remote namespace that `@deepseek-ai/dsh-api-settings-controller` publishes; it holds no token and never sees one, because every managed method returns only the safe `ManagedAuthState` projection. The Host owns the session record, the device binding, and the workspace the signed-in user opens.

The card reuses the visual language of the shipped account sign-in dialog — the same card border, header geometry, body copy size, and 36px action row — so a deployment offering both surfaces presents one family. It adds the credential form, which the shipped dialog has no need for.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [llm-managed-backend](../../llm/llm-managed-backend/README.md) — the adapter whose presence decides whether this step has anything to ask.
- [api-settings-controller](../../api/settings-controller/README.md) — the `credentials` Remote namespace this step drives.
- [ui-settings](../../client/ui-settings/README.md) — the settings shell that declares `settings.onboarding`.
- [ui-settings-account](../ui-settings-account/README.md) — the shipped DeepSeek account surface whose dialog this card follows.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly: the session this step stores is what `@deepseek-ai/dsh-llm-managed-backend` authenticates its catalog and generation requests with. The step itself reaches no model and adds nothing to a prompt.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- In a managed deployment, the existing Desktop account launcher shows the organization identity and its sign-in or sign-out action in the usual sidebar position. The DeepSeek platform account launcher is disabled for that deployment.
- **The step owns its whole card.** The settings shell paints no chrome for an onboarding step, so the CAS waiting state, the credential form, and every failure sentence live here rather than in shared modal copy.

### Connection state

Temporary status failures preserve the previously verified identity and show a connection warning. A pending status response cannot replace the signed-out state after manual logout.

### Dev Note

None.
