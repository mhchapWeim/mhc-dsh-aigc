import { describe, expect, it } from 'vitest'
import { resolveDesktopManagedBackend } from '../scripts/desktop-managed-backend.mjs'
import { managedBackendHostEnvironment } from '../src/managed-backend-environment.ts'

describe('packaged organization backend', () => {
  it('bundles the approved internal AIGC API for Windows test installations', () => {
    const config = resolveDesktopManagedBackend({}, 'win32')
    expect(config).toEqual({ baseURL: 'https://aigcbackend.boschhuayu-steering.com', allowInsecureHTTP: false })
    expect(managedBackendHostEnvironment({ dshManagedBackend: config }, true, {
      DSH_MANAGED_BACKEND_URL: 'https://stale.example.test',
      NODE_USE_SYSTEM_CA: '0',
    })).toMatchObject({
      DSH_MANAGED_BACKEND_URL: 'https://aigcbackend.boschhuayu-steering.com',
      DSH_MANAGED_BACKEND_INSECURE_HTTP: '0',
      ...(process.platform === 'win32' ? { NODE_USE_SYSTEM_CA: '1', DSH_WORKSPACE_ROOT: 'D:\\wanzaiwork' } : {}),
    })
  })

  it.each(['3000', '5080'])('uses the approved cloud HTTP backend on port %s', (port) => {
    const config = resolveDesktopManagedBackend({ DSH_DESKTOP_MANAGED_BACKEND_URL: `http://101.132.227.49:${port}` }, 'win32')
    expect(config).toEqual({ baseURL: `http://101.132.227.49:${port}`, allowInsecureHTTP: true })
    expect(managedBackendHostEnvironment({ dshManagedBackend: config }, true, {})).toMatchObject({
      DSH_MANAGED_BACKEND_URL: `http://101.132.227.49:${port}`, DSH_MANAGED_BACKEND_INSECURE_HTTP: '1',
    })
    expect(() => managedBackendHostEnvironment({ dshManagedBackend: {
      baseURL: `http://101.132.227.49:${port}`, allowInsecureHTTP: false,
    } }, true, {})).toThrow()
  })

  it('restricts development workspaces without replacing the development API', () => {
    const environment = { DSH_MANAGED_BACKEND_URL: 'https://development.example.test', DSH_WORKSPACE_ROOT: 'C:\\outside' }
    const actual = managedBackendHostEnvironment({}, false, environment)
    expect(actual).toEqual({ ...environment,
      ...(process.platform === 'win32' ? { DSH_WORKSPACE_ROOT: 'D:\\wanzaiwork' } : {}),
    })
    expect(environment.DSH_WORKSPACE_ROOT).toBe('C:\\outside')
    expect(managedBackendHostEnvironment({}, true, environment)).toEqual(actual)
    expect(resolveDesktopManagedBackend({}, 'darwin')).toBeUndefined()
  })

  it('requires an explicit managed API origin for production Windows builds', () => {
    expect(() => resolveDesktopManagedBackend({ DSH_DESKTOP_AUTO_UPDATE_ENV: 'production' }, 'win32'))
      .toThrow('DSH_DESKTOP_MANAGED_BACKEND_URL')
    expect(resolveDesktopManagedBackend({ DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
      DSH_DESKTOP_MANAGED_BACKEND_URL: 'https://aigc.example.test' }, 'win32'))
      .toEqual({ baseURL: 'https://aigc.example.test', allowInsecureHTTP: false })
  })

  it.each([
    'http://example.test:5080',
    'http://101.132.227.49:5081',
    'http://101.132.227.49:5080/v1',
    'http://172.28.12.33:5081',
    'http://172.28.12.33:5080/v1',
    'https://user:password@example.test',
  ])('rejects an unapproved packaging address: %s', (address) => {
    expect(() => resolveDesktopManagedBackend({ DSH_DESKTOP_MANAGED_BACKEND_URL: address }, 'win32')).toThrow()
  })

  it('refuses malformed packaged metadata', () => {
    expect(() => managedBackendHostEnvironment({ dshManagedBackend: {
      baseURL: 'http://example.test:5080', allowInsecureHTTP: true,
    } }, true, {})).toThrow()
    expect(() => managedBackendHostEnvironment({ dshManagedBackend: {
      baseURL: 'http://172.28.12.33:5080', allowInsecureHTTP: false,
    } }, true, {})).toThrow()
  })
})
