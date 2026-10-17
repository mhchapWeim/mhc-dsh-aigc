/** Portable binary objects referenced by a conversation snapshot. */
import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { z } from 'zod'

const file = z.object({
  attachmentId: z.string().regex(/^sha256:[a-f0-9]{64}$/).transform(AttachmentId),
  name: z.string(), bytes: z.number().int().nonnegative(),
})
const image = z.object({
  attachmentId: z.string().regex(/^sha256:[a-f0-9]{64}$/).transform(AttachmentId),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  bytes: z.number().int().nonnegative(), width: z.number().int().positive(), height: z.number().int().positive(),
  name: z.string().optional(),
}).transform(({ name, ...rest }) => ({ ...rest, ...(name === undefined ? {} : { name }) }))
const objectSchema = z.object({ ref: z.union([image, file]), data: z.string() })
type PortableObject = z.infer<typeof objectSchema>
const limit = 24 * 1024 * 1024

function refs(value: unknown): (FileAttachmentRef | ImageAttachmentRef)[] {
  if (Array.isArray(value)) return value.flatMap(refs)
  if (value === null || typeof value !== 'object') return []
  const parsed = z.union([image, file]).safeParse(value)
  if (parsed.success) return [parsed.data]
  return Object.values(value).flatMap(refs)
}

/** Count encoded object bytes without loading binaries or enforcing upload limits. */
export function measureObjects(sessions: unknown): number {
  const seen = new Set<string>()
  let bytes = 2 // JSON array brackets.
  for (const ref of refs(sessions)) {
    const key = `${ref.attachmentId}/${'mediaType' in ref ? ref.mediaType : ref.name}`
    if (seen.has(key)) continue
    if (seen.size > 0) bytes += 1
    seen.add(key)
    bytes += Buffer.byteLength(JSON.stringify({ ref, data: '' })) + Math.ceil(ref.bytes / 3) * 4
  }
  return bytes
}

export async function exportObjects(ctx: Context, sessions: unknown): Promise<PortableObject[]> {
  const objects: PortableObject[] = []
  const seen = new Set<string>()
  let bytes = Buffer.byteLength(JSON.stringify(sessions))
  for (const ref of refs(sessions)) {
    const key = `${ref.attachmentId}/${'mediaType' in ref ? ref.mediaType : ref.name}`
    if (seen.has(key)) continue
    seen.add(key)
    bytes += Math.ceil(ref.bytes / 3) * 4
    if (bytes > limit) throw new Error('Backup exceeds 24 MiB; select fewer Sessions')
    const store = ctx.get('attachments')
    if (store === undefined) throw new Error('Attachment storage is unavailable')
    let data: Buffer
    if ('mediaType' in ref) data = Buffer.from((await store.readImage(ref)).data)
    else {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of store.readFileStream(ref)) {
        size += chunk.length
        if (size > limit) throw new Error('Attachment exceeds backup limit')
        chunks.push(Buffer.from(chunk))
      }
      data = Buffer.concat(chunks)
    }
    objects.push({ ref, data: data.toString('base64') })
  }
  return objects
}

export async function importObjects(ctx: Context, payload: string): Promise<string> {
  const archive = z.looseObject({
    objects: z.array(objectSchema).default([]), sessions: z.array(z.unknown()),
  }).parse(JSON.parse(payload))
  const replacements = new Map<string, FileAttachmentRef | ImageAttachmentRef>()
  for (const object of archive.objects) {
    const data = Buffer.from(object.data, 'base64')
    if (data.toString('base64') !== object.data || data.length !== object.ref.bytes) throw new Error('Invalid attachment encoding')
    if (`sha256:${createHash('sha256').update(data).digest('hex')}` !== object.ref.attachmentId) throw new Error('Attachment checksum mismatch')
    const store = ctx.get('attachments')
    if (store === undefined) throw new Error('Attachment storage is unavailable')
    const ref = 'mediaType' in object.ref
      ? await store.saveImage({
        data, mediaType: object.ref.mediaType, ...(object.ref.name === undefined ? {} : { name: object.ref.name }),
      })
      : await store.saveFile({ data, name: object.ref.name })
    replacements.set(`${object.ref.attachmentId}/${'mediaType' in object.ref ? object.ref.mediaType : object.ref.name}`, ref)
  }
  function replace(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(replace)
    if (value === null || typeof value !== 'object') return value
    const parsed = z.union([image, file]).safeParse(value)
    if (parsed.success) {
      const ref = parsed.data
      const replacement = replacements.get(`${ref.attachmentId}/${'mediaType' in ref ? ref.mediaType : ref.name}`)
      if (replacement === undefined) throw new Error('Backup is missing an attachment')
      return replacement
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replace(child)]))
  }
  return JSON.stringify({ ...archive, objects: undefined, sessions: replace(archive.sessions) })
}
