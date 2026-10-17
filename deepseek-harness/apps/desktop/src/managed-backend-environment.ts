/** Apply the Windows workspace policy and packaged organization API to the Desktop Host. */

interface PackagedManagedBackend {
  readonly baseURL: string
  readonly allowInsecureHTTP: boolean
}

/**
 * @param manifest - Electron's packaged application manifest.
 * @param packaged - Whether the application is running from an installer.
 * @param inherited - Main-process environment; Windows always uses the fixed workspace root.
 * @returns Environment passed to the private Desktop Host.
 */
export function managedBackendHostEnvironment(manifest: unknown, packaged: boolean,
  inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = process.platform === 'win32' ? { ...inherited, DSH_WORKSPACE_ROOT: 'D:\\wanzaiwork' } : inherited
  if (!packaged || typeof manifest !== 'object' || manifest === null || !('dshManagedBackend' in manifest)) return environment
  const config: unknown = manifest.dshManagedBackend
  if (!isManagedBackend(config)) throw new Error('desktop managed backend: invalid packaged configuration')
  const url = new URL(config.baseURL)
  const testHttp = url.protocol === 'http:' && ((url.hostname === '172.28.12.33' && url.port === '5080')
    || (url.hostname === '101.132.227.49' && ['3000', '5080'].includes(url.port)))
  if ((url.protocol !== 'https:' && !testHttp) || url.username || url.password || url.pathname !== '/'
    || url.search || url.hash || config.allowInsecureHTTP !== testHttp) {
    throw new Error('desktop managed backend: invalid packaged API origin')
  }
  return { ...environment, DSH_MANAGED_BACKEND_URL: url.origin,
    DSH_MANAGED_BACKEND_INSECURE_HTTP: testHttp ? '1' : '0',
    // The organization CA is trusted by Windows, but not by Node's bundled CA set.
    // This is inherited by the private Desktop Host when it starts in Electron Node mode.
    ...(process.platform === 'win32' && !testHttp ? { NODE_USE_SYSTEM_CA: '1' } : {}),
  }
}

function isManagedBackend(value: unknown): value is PackagedManagedBackend {
  return typeof value === 'object' && value !== null && 'baseURL' in value && typeof value.baseURL === 'string'
    && 'allowInsecureHTTP' in value && typeof value.allowInsecureHTTP === 'boolean'
}
