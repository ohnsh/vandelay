import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { digest, scope } from '@vandelay/ddb/model'
import type { Asset, Publication } from '../src/model'
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
test('older pinned publications stay readable without falling back to full days for previews', async () => {
  const { current, read } = setup()
  const manifest = JSON.parse((await read(current.manifest.path)).toString())
  delete manifest.days[0].preview
  const bytes = Buffer.from(JSON.stringify(manifest)), sha256 = digest(bytes)
  const ref = { path: `publications/${sha256}/manifest.json`, sha256, bytes: bytes.length }
  const reads: string[] = []
  const legacy = await openPublication(async path => {
    reads.push(path)
    return path === ref.path ? bytes : read(path)
  }, { ...current, manifest: ref })
  expect(await legacy.preview('2026-11-14')).toBeUndefined()
  expect(reads).toEqual([ref.path])
  expect((await legacy.day('2026-11-14'))?.scope.day).toBe('2026-11-14')
})
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
  expect((await upload(root, remote.store)).uploaded).toBe(3)
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
test('feed and playback load independently; range maps preserve holes and chunk switches', async () => {
  const { root, read } = setup(), pub = fixture(), day = pub.days[0]
  mkdirSync(join(root, 'media'))
  const assets: Asset[] = ['a.mp4', 'b.mp4', 'p.webp'].map(name => {
    const sha256 = digest(name), ext = name.split('.')[1], path = `media/${sha256}.${ext}`
    writeFileSync(join(root, path), name)
    return { path, sha256, bytes: name.length, mediaType: ext === 'mp4' ? 'video/mp4' : 'image/webp',
      recipe: 'fixture', inputs: [] }
  })
  const time = { model: 'instant', at: day.scope.start, basis: 'capture' } as const
  day.frames = [2, 2.25, 3, 1].map((offset, i) => ({
    key: `${i}`, recordID: `${i}`, anchor: `${i}`, source: 's', at: time.at, time, disposition: 'available',
    previewStatus: 'available', preview: assets[2].path,
    playback: { asset: assets[i === 3 ? 1 : 0].path, offset, duration: .25 },
  }))
  day.entries = Array.from({ length: 7 }, (_, i) => ({
    anchor: `a${i}`, recordID: `${i}`, source: 's', track: i === 1 ? 'window' : 'activity',
    status: i === 0 ? 'withheld' : 'active', title: `${i}`, text: 'x'.repeat(1000), kind: 'fixture',
    time, placement: time, details: [], links: [], apps: [], frameKeys: [], provenance: 'fixture',
  }))
  day.timelapses = [{ source: 's', stream: 'main', clip: { selection: 'day', label: 'Main', frameKeys: ['0','1','2','3'] } }]
  writePublication(root, pub, assets, root)
  const reads: string[] = []
  const reader = await openPublication(async path => { reads.push(path); return read(path) })
  reads.length = 0
  const ref = reader.manifest.days[0].preview!
  const preview = (await reader.preview(day.scope.day))!
  expect(reads).toEqual([ref.path])
  expect(preview.highlights.map(h => h.anchor)).toEqual(['a2', 'a4', 'a6'])
  expect(preview.highlights[0].summary).toHaveLength(240)
  const t = preview.timelapses[0]
  expect(t).toMatchObject({ source: 's', stream: 'main', poster: assets[2].path })
  expect((await reader.playback(t.playback)).ranges).toEqual([
    { url: assets[0].path, start: 2, end: 2.5 }, { url: assets[0].path, start: 3, end: 3.25 },
    { url: assets[1].path, start: 1, end: 1.25 },
  ])
  expect(reads).toEqual([ref.path, t.playback.path])
  const remote = memoryStore()
  await upload(root, remote.store)
  expect(remote.writes.indexOf(t.playback.path)).toBeLessThan(remote.writes.indexOf(ref.path))
  expect(remote.values.has(t.playback.path)).toBe(true)
  writeFileSync(join(root, t.playback.path), '{}')
  const fresh = memoryStore()
  await expect(upload(root, fresh.store)).rejects.toThrow('hash/size mismatch')
  expect(fresh.writes).toEqual([])
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
