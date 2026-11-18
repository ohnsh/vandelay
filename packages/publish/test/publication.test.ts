import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { digest, scope } from '@vandelay/ddb/model'
import type { Current, Publication } from '../src/model'
import { writePublication } from '../src/store'
import { httpReader, openPublication } from '../src/reader'
import { upload, type ObjectStore } from '../src/upload'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })))
export function fixture(): Publication {
  return {
    schema: 'vandelay.publish/v1', commit: 'a'.repeat(40), generator: 'fixture',
    generatorDigest: digest('fixture'), configuration: { media: 'none', captureStride: 1 },
    inputDigest: digest('input'), verification: { archive: 'verified', signature: 'not checked', timestamp: 'not checked' },
    days: [{
      schema: 'vandelay.publish.day/v1', scope: scope('2026-11-14', 'UTC'),
      sources: [], frames: [], entries: [], timelapses: [],
    }],
  }
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'vandelay-publication-')); roots.push(root)
  const current = writePublication(root, fixture(), [], root)
  const read = async (path: string) => readFileSync(join(root, path))
  return { root, current, read }
}
test('immutable generations, pinned HTTP reader, missing days, and hash verification', async () => {
  const { root, current, read } = setup()
  const original = await openPublication(read)
  const update = fixture(); update.commit = 'b'.repeat(40)
  const next = writePublication(root, update, [], root)
  expect(next.manifest.path).not.toBe(current.manifest.path)
  expect((await openPublication(read)).manifest.commit).toBe(update.commit)
  expect((await openPublication(read, current)).manifest.commit).toBe(fixture().commit)
  // Metadata-only publication changes reuse day objects.
  expect((await openPublication(read)).manifest.days[0].object).toEqual(original.manifest.days[0].object)
  expect(await original.day('1900-01-01')).toBeUndefined()
  const fetched: string[] = []
  const fakeFetch = (async (url: URL) => {
    fetched.push(url.pathname)
    return new Response(await read(url.pathname.slice('/publication/'.length)))
  }) as unknown as typeof fetch
  const http = await openPublication(httpReader('https://example.test/publication/', fakeFetch), current)
  expect((await http.day('2026-11-14'))!.scope.day).toBe('2026-11-14')
  expect(fetched.some(p => p.endsWith('current.json'))).toBe(false)
  writeFileSync(join(root, original.manifest.days[0].object.path), '{}')
  await expect(original.day('2026-11-14')).rejects.toThrow('hash/size mismatch')
  const unsafe = { ...current, manifest: { ...current.manifest, path: '../outside' } }
  await expect(openPublication(read, unsafe)).rejects.toThrow('unsafe object path')
})
function memoryStore() {
  const values = new Map<string, { etag: string; sha256: string; bytes: number; body: Uint8Array }>()
  const writes: string[] = []
  const store: ObjectStore = {
    async head(path) { return values.get(path) },
    async put(path, body, options) {
      const existing = values.get(path)
      if (options.condition && existing?.etag !== options.condition.etag) throw new Error('precondition')
      writes.push(path)
      values.set(path, { etag: digest(body), sha256: options.sha256, bytes: body.length, body })
    },
  }
  return { store, values, writes }
}
test('upload commits pointer last, retries without duplicate objects, and preserves old pointer on failure', async () => {
  const { root } = setup(), remote = memoryStore()
  expect((await upload(root, remote.store)).uploaded).toBe(2)
  expect(remote.writes.at(-1)).toBe('current.json')
  const original = remote.values.get('current.json')!
  const count = remote.writes.length
  expect((await upload(root, remote.store)).uploaded).toBe(0)
  expect(remote.writes).toHaveLength(count)
  const next = fixture(); next.commit = 'c'.repeat(40)
  writePublication(root, next, [], root)
  const fail: ObjectStore = { ...remote.store, async put(path, body, options) {
    if (path.startsWith('publications/')) throw new Error('upload interrupted')
    return remote.store.put(path, body, options)
  } }
  await expect(upload(root, fail)).rejects.toThrow('upload interrupted')
  expect(remote.values.get('current.json')).toBe(original)
  await upload(root, remote.store)
  expect(remote.values.get('current.json')).not.toBe(original)
})
test('concurrent publisher cannot overwrite a changed discovery pointer', async () => {
  const { root } = setup(), remote = memoryStore()
  await upload(root, remote.store)
  const next = fixture(); next.commit = 'd'.repeat(40)
  writePublication(root, next, [], root)
  const race: ObjectStore = { ...remote.store, async put(path, body, options) {
    if (path === 'current.json') remote.values.get(path)!.etag = 'concurrent-write'
    return remote.store.put(path, body, options)
  } }
  await expect(upload(root, race)).rejects.toThrow('precondition')
})
test('invalid local dependencies cause zero remote writes', async () => {
  const { root, read } = setup(), remote = memoryStore()
  const reader = await openPublication(read)
  writeFileSync(join(root, reader.manifest.days[0].object.path), 'bad')
  await expect(upload(root, remote.store)).rejects.toThrow('hash/size mismatch')
  expect(remote.writes).toEqual([])
})
