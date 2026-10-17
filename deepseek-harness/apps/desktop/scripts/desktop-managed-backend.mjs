/** Resolve the organization API address sealed into a Windows Desktop package. */

const WINDOWS_TEST_BACKEND = 'https://aigcbackend.boschhuayu-steering.com'

/**
 * @param {NodeJS.ProcessEnv} environment - File-owned packaging settings.
 * @param {NodeJS.Platform} platform - Target platform.
 * @returns {{ baseURL: string, allowInsecureHTTP: boolean } | undefined} Packaged backend configuration.
 */
export function resolveDesktopManagedBackend(environment, platform) {
  const configured = environment.DSH_DESKTOP_MANAGED_BACKEND_URL?.trim()
  const production = environment.DSH_DESKTOP_AUTO_UPDATE_ENV === 'production'
  if (platform === 'win32' && production && !configured) {
    throw new Error('desktop package: production Windows builds require DSH_DESKTOP_MANAGED_BACKEND_URL')
  }
  const value = configured || (platform === 'win32' ? WINDOWS_TEST_BACKEND : undefined)
  if (value === undefined) return undefined
  let url
  try { url = new URL(value) }
  catch { throw new Error('desktop package: DSH_DESKTOP_MANAGED_BACKEND_URL must be an absolute API origin') }
  const testHttp = url.protocol === 'http:' && ((url.hostname === '172.28.12.33' && url.port === '5080')
    || (url.hostname === '101.132.227.49' && ['3000', '5080'].includes(url.port)))
  if ((url.protocol !== 'https:' && !testHttp) || url.username || url.password || url.pathname !== '/'
    || url.search || url.hash) {
    throw new Error('desktop package: DSH_DESKTOP_MANAGED_BACKEND_URL must be an HTTPS origin or the approved deployment HTTP origin')
  }
  return { baseURL: url.origin, allowInsecureHTTP: testHttp }
}
