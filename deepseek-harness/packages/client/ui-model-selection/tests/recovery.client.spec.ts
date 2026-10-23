// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { expect, it, vi } from 'vitest'
import { ModelDirectoryResolver } from '../src/client/service.ts'

it('reloads a failed AIGC catalog on browser recovery even while the local Host stays connected', async () => {
  const ctx = new Context()
  const value = { default: { provider: 'managed', model: 'model' }, routableProviders: ['managed'], groups: [], failures: [] }
  const modelCatalog = vi.fn().mockResolvedValueOnce({ ok: true, value: { ...value, failures: [{ id: 'managed', name: 'Managed', message: 'offline' }] } })
    .mockResolvedValue({ ok: true, value })
  new TestRemote(ctx, { session: { modelCatalog } })
  new ModelDirectoryResolver(ctx, { blockReason: () => 'unavailable' })
  try {
    await vi.waitFor(() => expect(modelCatalog).toHaveBeenCalledTimes(1))
    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(modelCatalog).toHaveBeenCalledTimes(2))
    await Promise.resolve()
    window.dispatchEvent(new Event('focus'))
    expect(modelCatalog).toHaveBeenCalledTimes(2)
  } finally { await ctx.fiber.dispose() }
  window.dispatchEvent(new Event('online'))
  expect(modelCatalog).toHaveBeenCalledTimes(2)
})
