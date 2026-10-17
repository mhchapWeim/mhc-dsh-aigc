/**
 * Browser-safe failure vocabulary of the configuration surfaces this package
 * serves. The redacted views themselves live with their seam in
 * `@deepseek-ai/dsh-settings/types`, whose Cordis event declarations already
 * register that file for the Client compilation face.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/types
 */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * Every seam refusal that is not a stale write: an unregistered or malformed
     * namespace, a read-only provider, schema validation, storage.
     */
    'settings/rejected': { readonly ns: string }
    /**
     * The stored revision moved after the caller read it. Its own outcome rather
     * than an invalid request: the caller must re-read and re-apply.
     */
    'settings/conflict': { readonly ns: string; readonly expected: number; readonly actual: number }
    /**
     * The provider refused a valid credential write, for example because a
     * read-only source shadows the reference. The details name only the
     * reference, never the value.
     */
    'credential/rejected': { readonly ref: string }
    /**
     * The organization backend refused a login, or an existing session stopped
     * being usable. `reason` separates the three fixes a surface offers: retype
     * the credentials, report a backend outage, or repair the local Workspace.
     */
    'managed-auth/rejected': { readonly reason: 'credentials' | 'backend' | 'workspace' | 'device-binding' }
  }
}

/** Confirmation that the settings document was handed to the native editor. */
export interface SettingsDocumentOpenValue {
  readonly opened: true
}

/**
 * Host-verified organization identity and the local Workspace it owns. The
 * bearer token that produced this state never crosses to the Client: `enabled`
 * with a `null` user is what a mounted backend reports before anyone signs in.
 */
export type ManagedAuthState =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly user: null }
  | {
    readonly enabled: true
    readonly user: { readonly id: string; readonly username: string }
    readonly models: readonly { readonly id: string; readonly name: string; readonly provider?: 'managed-internal' }[]
    readonly workspaceId?: string
    readonly workspacePath: string
    /** Authentication succeeded; local data can be repaired independently. */
    readonly workspaceIssue?: 'unavailable'
  }

/** The backend's BHSS CAS entry point, which a Client opens without holding backend credentials. */
export type ManagedCasConfig =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly loginUrl: string; readonly logoutUrl: string; readonly service: string }

/** One browser login a Client completes outside DSH, then polls for. */
export interface ManagedCasDeviceLogin {
  /** Page the Client opens in the system browser to authenticate. */
  readonly browserUrl: string
  /** Opaque handle this Host polls; it names the pending login, not the user. */
  readonly deviceCode: string
  /** Minimum seconds between two polls, as the backend requests. */
  readonly intervalSeconds: number
}
