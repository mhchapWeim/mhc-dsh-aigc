/** Binary attachments and individual Session files keep cloud transfers bounded. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import * as tar from 'tar'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { refs } from './portable-attachments.ts'

const file = z.object({ file: z.string().regex(/^(sessions\/[a-f0-9]{64}\.json|objects\/[a-f0-9]{64}\.bin)$/), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
export const manifestSchema = z.object({ version: z.literal(2), sessions: z.array(file.extend({ id: z.string().min(1), title: z.string().max(512) })).min(1).max(10000),
  objects: z.array(file.extend({ ref: z.unknown() })).max(10000) })
export type CloudManifest = z.infer<typeof manifestSchema>
export function objectFile(ref: FileAttachmentRef | ImageAttachmentRef): string { return `objects/${ref.attachmentId.replace('sha256:', '')}.bin` }
export async function fileHash(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** Write exact referenced objects once, without Base64 or whole-file collection. */
export async function exportBinaryObjects(ctx: Context, sessions: unknown, folder: string, manifest: CloudManifest, maximumBytes: number): Promise<void> {
  const store = ctx.get('attachments')
  for (const ref of refs(sessions)) {
    const file = objectFile(ref)
    if (manifest.objects.some(item => item.file === file)) continue
    if (manifest.objects.reduce((sum, item) => sum + item.bytes, 0) + ref.bytes > maximumBytes) throw new Error('Backup exceeds capacity limit')
    if (store === undefined) throw new Error('Attachment storage is unavailable')
    const path = join(folder, file)
    if ('mediaType' in ref) await writeFile(path, (await store.readImage(ref)).data, { mode: 0o600 })
    else await pipeline(createReadStreamFrom(store.readFileStream(ref)), createWriteStream(path, { mode: 0o600 }))
    if ((await stat(path)).size !== ref.bytes || `sha256:${await fileHash(path)}` !== ref.attachmentId) throw new Error('Attachment checksum mismatch')
    manifest.objects.push({ file, bytes: ref.bytes, sha256: ref.attachmentId.slice(7), ref })
  }
}
import { Readable } from 'node:stream'
function createReadStreamFrom(data: AsyncIterable<Uint8Array>): Readable { return Readable.from(data) }

export async function packArchive(folder: string, manifest: CloudManifest): Promise<{ bytes: number; sha256: string }> {
  const file = join(folder, 'snapshot.tar.gz')
  await tar.c({ cwd: folder, file, gzip: true, portable: true }, [...manifest.sessions, ...manifest.objects].map(item => item.file))
  return { bytes: (await stat(file)).size, sha256: await fileHash(file) }
}

/** Admit only declared regular files with exact byte counts and hashes. */
export async function unpackArchive(folder: string, input: CloudManifest, maximumBytes: number): Promise<void> {
  const manifest = manifestSchema.parse(input)
  const files = [...manifest.sessions, ...manifest.objects]
  if (files.reduce((sum, item) => sum + item.bytes, 0) > maximumBytes) throw new Error('Backup exceeds capacity limit')
  const expected = new Map(files.map(item => [item.file, item]))
  if (expected.size !== files.length) throw new Error('Duplicate backup file')
  const extracted = join(folder, 'extracted')
  await mkdir(extracted, { recursive: true, mode: 0o700 })
  const seen = new Set<string>()
  const unpack = tar.x({ cwd: extracted, strict: true,
    filter: (path, entry) => {
      const item = expected.get(path)
      if (item === undefined || seen.has(path) || !('type' in entry) || entry.type !== 'File' || entry.size !== item.bytes) {
        unpack.abort(new Error('Invalid backup archive entry'))
        return false
      }
      seen.add(path)
      return true
    } })
  await new Promise<void>((resolve, reject) => {
    const source = createReadStream(join(folder, 'snapshot.tar.gz'))
    source.on('error', error => { unpack.abort(error); reject(error) })
    unpack.on('error', error => { source.destroy(); reject(error) })
    unpack.on('close', resolve)
    source.pipe(unpack)
  })
  if (seen.size !== files.length) throw new Error('Backup archive is incomplete')
  for (const item of files) if (await fileHash(join(extracted, item.file)) !== item.sha256) throw new Error('Backup file checksum mismatch')
}

/** Rehydrate only objects referenced by the Session being restored. */
export async function restoreBinaryObjects(ctx: Context, session: unknown, folder: string, manifest: CloudManifest): Promise<unknown> {
  const store = ctx.get('attachments')
  const replacements = new Map<string, FileAttachmentRef | ImageAttachmentRef>()
  for (const ref of refs(session)) {
    if (store === undefined) throw new Error('Attachment storage is unavailable')
    const item = manifest.objects.find(item => item.file === objectFile(ref))
    if (item === undefined || item.bytes !== ref.bytes || `sha256:${item.sha256}` !== ref.attachmentId) throw new Error('Backup attachment is missing')
    const path = join(folder, 'extracted', item.file)
    const restored = 'mediaType' in ref ? await store.saveImage({ data: await readFile(path), mediaType: ref.mediaType, ...(ref.name === undefined ? {} : { name: ref.name }) })
      : await store.saveFileStream({ data: createReadStream(path), name: ref.name })
    replacements.set(JSON.stringify(ref), restored)
  }
  const replace = (value: unknown): unknown => {
    const replacement = replacements.get(JSON.stringify(value))
    if (replacement !== undefined) return replacement
    if (Array.isArray(value)) return value.map(replace)
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replace(child)]))
    return value
  }
  return replace(session)
}
