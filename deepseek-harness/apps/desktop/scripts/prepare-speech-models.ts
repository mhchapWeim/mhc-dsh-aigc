/** Release-pinned INT8 speech models carried as ordinary Desktop resources. */
import { cp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { downloadAsset } from '../../../packages/experimental/speech-to-text-sensevoice/src/runtime.ts'
import assets from '../../../packages/experimental/speech-to-text-sensevoice/runtime/assets.json' with { type: 'json' }

/** Prepare and hash-check all speech assets before copying them into the installer resources.
 * @param runtime - Target-owned resource directory.
 * @param cache - Reusable build download directory.
 */
export async function prepareSpeechModels(runtime: string, cache: string): Promise<void> {
  const destination = join(runtime, 'speech-models')
  await mkdir(destination, { recursive: true })
  for (const asset of [assets.models.int8, assets.tokens, assets.vad]) {
    console.log(`speech models: verifying/preparing ${asset.name} (${asset.bytes} bytes)`)
    const source = await downloadAsset(asset, join(cache, 'speech-models'), AbortSignal.timeout(15 * 60_000))
    await cp(source, join(destination, asset.name))
  }
}
