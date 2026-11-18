import type { Current, ObjectRef, PublicationManifest, PublishedDay } from './model'
import { discoveryPath } from './discovery'
import { objectPath, validateCurrent, validateDay, validateManifest, validatePlayback, validatePlaybackRef, validatePreview } from './validate'

/** No filesystem, Bun, or Node dependency: usable in Astro builds and Workers SSR. */
export type ReadObject = (path: string) => Promise<Uint8Array>
export function httpReader(base: string, fetcher: typeof fetch = fetch): ReadObject {
  const root = new URL(base.endsWith('/') ? base : `${base}/`)
  if (!['http:', 'https:'].includes(root.protocol)) throw new Error('Expected HTTP publication origin')
  return async path => {
    objectPath(path)
    const response = await fetcher(new URL(path, root))
    if (!response.ok) throw new Error(`Publication fetch failed (${response.status}): ${path}`)
    return new Uint8Array(await response.arrayBuffer())
  }
}
async function verified(read: ReadObject, ref: ObjectRef): Promise<unknown> {
  const bytes = await read(ref.path)
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)))]
    .map(b => b.toString(16).padStart(2, '0')).join('')
  if (bytes.length !== ref.bytes || hash !== ref.sha256) throw new Error(`Publication hash/size mismatch: ${ref.path}`)
  return JSON.parse(new TextDecoder().decode(bytes))
}
/** Resolve discovery exactly once. Subsequent day reads are pinned to this immutable manifest. */
export async function openPublication(read: ReadObject, selection?: Current | { channel?: string; pinned?: Current }) {
  const options = selection && 'schema' in selection ? { pinned: selection } : selection
  if (options?.pinned && options.channel !== undefined) throw new Error('Choose a pin or a channel, not both')
  const path = discoveryPath(options?.channel)
  const current: unknown = options?.pinned ?? JSON.parse(new TextDecoder().decode(await read(path)))
  validateCurrent(current)
  const manifest = await verified(read, current.manifest)
  validateManifest(manifest)
  return {
    current, manifest,
    async preview(date: string) {
      const day = manifest.days.find(d => d.scope.day === date)
      if (!day?.preview) return undefined
      const preview = await verified(read, day.preview)
      validatePreview(preview)
      if (JSON.stringify(preview.scope) !== JSON.stringify(day.scope)) throw new Error('Preview scope disagreement')
      return preview
    },
    async playback(ref: ObjectRef) {
      validatePlaybackRef(ref)
      const map = await verified(read, ref)
      validatePlayback(map)
      return map
    },
    async day(date: string): Promise<PublishedDay | undefined> {
      const ref = manifest.days.find(d => d.scope.day === date)
      if (!ref) return undefined
      const day = await verified(read, ref.object)
      validateDay(day)
      if (JSON.stringify(day.scope) !== JSON.stringify(ref.scope)) throw new Error('Day scope disagreement')
      return day
    },
  }
}
export type PublicationReader = Awaited<ReturnType<typeof openPublication>>
