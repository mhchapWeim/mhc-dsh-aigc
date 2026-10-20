---
description: "Authenticated organization-backend model adapter with per-token model discovery and NDJSON generation."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-managed-backend

English | [中文](README.zh.md)

## Summary

The backend may include `imageInput: { state, source, reason }` alongside the legacy `input` field. The adapter preserves `state` as `imageInputState`; `unknown` blocks image dispatch with a configuration error while allowing text requests. Administrators can explicitly override upstream metadata in AIGC. Older catalogs without the field keep their previous behavior.

An organization can serve only the models granted to a backend-issued token and keep its upstream provider API keys on the backend. The adapter reads the granted model list and a short-lived connection from the backend, then generates directly against that connection. The backend verifies the token on every catalog read, and the connection key it issues is scoped to the granted models and expires on its own; the local catalog is not an authorization decision. This package does not authenticate a person or issue tokens.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package only when an organization backend implements the API below. Desktop login saves a backend-issued token in a Host credential record; other profiles may use a configured credential reference.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | — | HTTPS backend root, or loopback HTTP for development; supply this or `baseURLEnv` |
| `baseURLEnv` | — | Trusted launch-environment variable containing the backend root |
| `tokenEnv` | — | Credential reference containing the backend-issued user token; use this or `tokenKey` |
| `tokenKey` | — | Host credential-record id under `llm-managed-backend`; use this or `tokenEnv` |
| `provider` | `managed` | DSH provider route owned by this adapter |
| `sessionTiming` | `renewBeforeMs: 300000`, `pollMs: 60000`, `requestTimeoutMs: 10000` | Persistent login renewal timing in milliseconds; omitted fields receive defaults and all values must be positive integers within the timer range |
| `uploadSync` | — | Optional durable background sync of submitted chat files; configure `pollMs`, `chunkBytes`, and `requestTimeoutMs` |

The [Desktop patch](../../../apps/desktop-host/config/desktop.cordis.patch.yml) activates this route when `DSH_MANAGED_BACKEND_URL` is set and reads the `user-session` Host credential record. Desktop login obtains the token from the backend; users do not enter a token. While mounted, this plugin rejects calls to other model providers and the Desktop selects the first model granted to the signed-in user. Disabling the plugin row restores ordinary provider routing; a missing managed token fails closed while the plugin remains mounted.

The `managedBackend.authorizeProvider(id)` effect permits an organization-owned extension provider until its disposer runs. The independent internal-model bundle uses this capability; other providers remain rejected.

### Backend API

The backend receives `Authorization: Bearer <token>` on the catalog read. `GET {baseURL}/v1/models` returns `{ "models": [{ "id": "default", "name": "Default" }], "connection": { "api": "openai-completions", "baseURL": "...", "apiKey": "...", "expiresAt": "..." } }`. Each id is unique, and the array contains only models available to that token. A model may also carry `contextWindow` and `maxOutputTokens`; each is optional, and a model that omits one falls back to the route's own default rather than to a capacity the backend did not state. The `connection` block names the wire protocol, the endpoint, and a short-lived key scoped to the granted models; the adapter sends that key directly to that endpoint, so generation does not return to the backend and the backend's own upstream credentials stay there. The adapter re-reads the catalog before every call, so a rotated or expired `apiKey` needs no DSH restart. A 401 means invalid authentication; 403 means model access denied.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The adapter resolves the credential for each model lookup or prepared call. Preparation binds that token to the ensuing generation request, while the backend decides whether it remains valid at dispatch. The model directory never comes from `settings.yaml`. When configured, [upload sync](src/upload-sync.ts) records submitted chat files in a local retry queue and resumes from the backend-confirmed offset after restart. It skips only that initial offset in the source stream; later chunk acknowledgements advance the destination offset without skipping more source bytes. The adapter and wire parsing are in [src/index.ts](src/index.ts); [adapter tests](tests/adapter.spec.ts) cover catalog admission, backend revocation, and stream completion.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [LLM adapter contract](../../../docs/subsystems/llm-streaming.md) — request and chunk semantics.
- [Credentials](../../credentials/credentials/README.md) — credential references and resolution.
- [Desktop application](../../../apps/desktop/README.md) — local Host composition.

-----

<a id="model-experience"></a>
## Model Experience

### Managed request

#### What the model sees

The backend receives the assembled DSH `messages` and `tools` fields. It determines how those fields reach its selected upstream model; the adapter adds no prompt text.

#### Token effect

The backend owns tokenization and returns any usage chunks. The adapter does not estimate provider-specific image cost.

#### KV Cache effect

The backend owns upstream cache behavior. DSH preserves the assembled request history and records returned chunks normally.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- Desktop login obtains the user token through the Host credentials controller. Other profiles must supply the token through their own trusted login flow.
- The backend API is DSH-specific: it must return the granted catalog and a connection whose key is scoped to exactly those models.
- Generation goes directly to the connection endpoint, so that endpoint must be reachable from the DSH host.
- A local user may alter a local DSH installation. Only the backend can enforce access to organization-held provider credentials and models.
- File synchronization scans submitted user messages only; the local queue keeps the prompt and stored-file path until the backend confirms completion.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

## Organization feedback

Organization mode provides feedback delivery to `/v1/feedback` using the current user token. Explicit Session feedback includes the current Session log, rejects logs above 2,000,000 characters, and uses a 30-second timeout with redirects disabled. The AIGC backend owns storage and administrator access.

## Persistent organization login

Password and CAS login persist a Host-only refresh grant. Access tokens renew silently before expiry and after restart; network errors retain the grant, while revocation and manual sign-out remove it. `sessionTiming` configures positive millisecond values for `renewBeforeMs`, `pollMs`, and `requestTimeoutMs` (defaults: 300000, 60000, 10000).

Managed catalogs accept the optional string `multiplier` (maximum 32 characters) and preserve it through list, resolution, and prepared-call metadata.
