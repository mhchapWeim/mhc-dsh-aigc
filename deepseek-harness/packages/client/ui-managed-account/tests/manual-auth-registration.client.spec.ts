// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'

it('registers only the manual account launcher and no automatic authentication step', () => {
  const register = vi.fn()
  const ctx = {
    effect: (callback: () => unknown) => callback(),
    locale: { register: vi.fn(), bind: () => vi.fn() },
    slots: { inject: (_name: string, callback: () => unknown) => callback(), register },
  } as unknown as Parameters<typeof apply>[0]
  apply(ctx)
  expect(register).toHaveBeenCalledOnce()
  expect(register.mock.calls[0]?.[0]).toMatchObject({ name: 'settings.launcher' })
})
