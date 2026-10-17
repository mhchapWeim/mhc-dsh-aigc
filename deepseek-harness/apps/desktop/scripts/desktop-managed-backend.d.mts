/** Packaged organization API location supplied by the Desktop release. */
export interface DesktopManagedBackendConfig {
  readonly baseURL: string
  readonly allowInsecureHTTP: boolean
}

/** Resolve an approved organization API origin for one target platform. */
export function resolveDesktopManagedBackend(
  environment: NodeJS.ProcessEnv, platform: NodeJS.Platform,
): DesktopManagedBackendConfig | undefined
