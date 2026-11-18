import { readFileSync } from 'node:fs'
import { AwsClient } from 'aws4fetch'
import { digest, safePath } from '@vandelay/ddb/model'
import { openPublication } from './reader'
import type { ObjectRef } from './model'

export interface ObjectStore {
  head(path: string): Promise<{ etag: string; sha256?: string; bytes: number } | undefined>
  put(path: string, bytes: Uint8Array, options: {
    type: string; cacheControl: string; sha256: string; condition?: { etag?: string }
  }): Promise<void>
}

/** R2's S3 endpoint, not its public delivery hostname. No Worker deployment is needed. */
export function r2Store(endpoint: string, bucket: string): ObjectStore {
  const accessKeyId = process.env.S3_ACCESS_KEY_ID
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY
  if (!accessKeyId || !secretAccessKey) throw new Error('Set S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY')
  const root = new URL(endpoint)
  if (root.protocol !== 'https:' || root.pathname !== '/') throw new Error('Expected HTTPS S3 endpoint without path')
  const aws = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' })
  const url = (path: string) => new URL(`${encodeURIComponent(bucket)}/${path}`, root).href
  return {
    async head(path) {
      // Compare stored bytes, not a negotiated gzip representation (which may omit Content-Length).
      const response = await aws.fetch(url(path), { method: 'HEAD', headers: { 'accept-encoding': 'identity' } })
      if (response.status === 404) return undefined
      if (!response.ok) throw new Error(`R2 HEAD ${path}: ${response.status}`)
      const etag = response.headers.get('etag')
      if (!etag) throw new Error('R2 response missing ETag')
      const length = response.headers.get('content-length')
      if (length === null || !/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))
        throw new Error(`R2 HEAD ${path}: missing or invalid Content-Length`)
      return { etag, sha256: response.headers.get('x-amz-meta-sha256') ?? undefined,
        bytes: Number(length) }
    },
    async put(path, bytes, options) {
      const response = await aws.fetch(url(path), {
        method: 'PUT', body: Uint8Array.from(bytes),
        headers: {
          'content-type': options.type, 'cache-control': options.cacheControl,
          'x-amz-meta-sha256': options.sha256,
          ...(options.condition
            ? options.condition.etag ? { 'if-match': options.condition.etag } : { 'if-none-match': '*' }
            : {}),
        },
      })
      if (!response.ok) throw new Error(`R2 PUT ${path}: ${response.status} ${await response.text()}`)
      await response.body?.cancel()
    },
  }
}

/** Verify all local objects before writing; upload the discovery pointer only after dependencies. */
export async function upload(root: string, store: ObjectStore) {
  const read = async (path: string) => readFileSync(safePath(root, path))
  const currentBytes = await read('current.json')
  const reader = await openPublication(read, JSON.parse(currentBytes.toString()))
  const assets = new Map<string, ObjectRef & { mediaType: string }>()
  const maps = new Map<string, ObjectRef>()
  const previews: ObjectRef[] = []
  for (const day of reader.manifest.days) {
    const inventory = (await reader.day(day.scope.day))!.assets
    for (const asset of inventory) assets.set(asset.path, asset)
    if (!day.preview) continue
    const paths = new Set(inventory.map(a => a.path))
    const preview = (await reader.preview(day.scope.day))!
    for (const t of preview.timelapses) {
      const map = await reader.playback(t.playback)
      if ((t.poster && !paths.has(t.poster)) || map.ranges.some(r => !paths.has(r.url)))
        throw new Error('Uninventoried preview media')
      maps.set(t.playback.path, t.playback)
    }
    previews.push(day.preview)
  }
  const objects: (ObjectRef & { mediaType?: string })[] = [
    ...assets.values(), ...maps.values(), ...previews, ...reader.manifest.days.map(d => d.object), reader.current.manifest,
  ]
  const verify = async (ref: ObjectRef) => {
    const bytes = await read(ref.path)
    if (digest(bytes) !== ref.sha256 || bytes.length !== ref.bytes) throw new Error(`Invalid upload object: ${ref.path}`)
    return bytes
  }
  for (const ref of objects) await verify(ref)
  const previous = await store.head('current.json')
  let uploaded = 0
  for (const ref of objects) {
    const existing = await store.head(ref.path)
    if (existing) {
      if (existing.sha256 !== ref.sha256 || existing.bytes !== ref.bytes)
        throw new Error(`Remote immutable object disagreement: ${ref.path}`)
      continue
    }
    await store.put(ref.path, await verify(ref), {
      type: ref.mediaType ?? 'application/json', cacheControl: 'public, max-age=31536000, immutable',
      sha256: ref.sha256, condition: {},
    })
    uploaded++
  }
  const hash = digest(currentBytes)
  if (previous?.sha256 !== hash) await store.put('current.json', currentBytes, {
    type: 'application/json', cacheControl: 'public, max-age=0, must-revalidate',
    sha256: hash, condition: { etag: previous?.etag },
  })
  return { uploaded, manifest: reader.current.manifest.path }
}
