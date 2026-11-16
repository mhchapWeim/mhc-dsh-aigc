/** Managed speech reuses the installed provider through a real Loader. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { boot } from '@deepseek-ai/dsh-app-boot'
import SpeechToText from '@deepseek-ai/dsh-experimental-speech-to-text'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import * as voice from '../../../../../plugins/dsh-plugin-managed-voice-input/src/index.js'

it('makes preinstalled models ready without downloads and withdraws the recognizer on disposal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'managed-voice-'))
  let shutdown: (() => Promise<void>) | undefined
  const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network must not be used'))
  vi.stubEnv('DSH_SPEECH_MODELS_ROOT', root)
  try {
    for (const name of ['model.int8.onnx', 'tokens.txt', 'silero_vad.onnx']) await writeFile(join(root, name), 'fixture')
    const config = join(root, 'cordis.yml')
    await writeFile(config, JSON.stringify([
      { id: 'speech', name: 'cordis:speech', config: { defaultProvider: 'sensevoice-local' } },
      { id: 'subprocess', name: 'cordis:subprocess' },
      { id: 'voice', name: 'cordis:voice', config: { dataRoot: root } },
    ]))
    const ctx = await boot('test', config, [], ctx => {
      ctx.loader.builtins.speech = SpeechToText
      ctx.loader.builtins.subprocess = LocalSubprocess
      ctx.loader.builtins.voice = voice
    })
    shutdown = async () => { await ctx.fiber.dispose() }
    await vi.waitFor(() => expect(ctx.speechToText.snapshot().providers[0]?.preparation?.phase).toBe('standby'))
    expect(fetcher).not.toHaveBeenCalled()
    const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'voice')
    await entry!.fiber!.dispose()
    expect(ctx.speechToText.listProviders()).toEqual([])
  } finally {
    await shutdown?.()
    fetcher.mockRestore()
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})
