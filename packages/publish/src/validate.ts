import type { Current, DailyPreview, ObjectRef, PlaybackManifest, PublicationManifest, PublishedDay } from './model'

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Invalid publication: ${message}`)
}
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
export function objectPath(path: unknown): asserts path is string {
  assert(typeof path === 'string' && /^[a-zA-Z0-9_./-]+$/.test(path) &&
    !path.startsWith('/') && path.split('/').every(p => p && p !== '.' && p !== '..'),
  'unsafe object path')
}
export function validateRef(value: unknown): asserts value is ObjectRef {
  assert(object(value), 'object reference')
  objectPath(value.path)
  assert(/^[a-f0-9]{64}$/.test(value.sha256) && Number.isSafeInteger(value.bytes) && value.bytes >= 0, 'hash/size')
}
export function validateCurrent(value: unknown): asserts value is Current {
  assert(object(value) && value.schema === 'vandelay.publish.current/v1', 'current schema')
  validateRef(value.manifest)
  assert(value.manifest.path === `publications/${value.manifest.sha256}/manifest.json`, 'manifest identity')
}
export function validateManifest(value: unknown): asserts value is PublicationManifest {
  assert(object(value) && value.schema === 'vandelay.publish/v1', 'manifest schema')
  assert(typeof value.commit === 'string' && typeof value.generator === 'string' &&
    /^[a-f0-9]{64}$/.test(value.inputDigest) && object(value.verification), 'provenance')
  assert(/^[a-f0-9]{64}$/.test(value.generatorDigest) && object(value.configuration) &&
    ['all', 'none'].includes(value.configuration.media) &&
    [1, 2, 3, 4].includes(value.configuration.captureStride), 'generator/configuration')
  assert(Array.isArray(value.days), 'day inventory')
  const dates = new Set<string>()
  for (const day of value.days) {
    assert(object(day) && object(day.scope) && /^\d{4}-\d{2}-\d{2}$/.test(day.scope.day), 'day scope')
    assert(!dates.has(day.scope.day), 'duplicate day')
    dates.add(day.scope.day)
    validateRef(day.object)
    assert(day.object.path === `days/${day.scope.day}/${day.object.sha256}.json`, 'day identity')
    if (day.preview !== undefined) {
      validateRef(day.preview)
      assert(day.preview.path === `previews/${day.scope.day}/${day.preview.sha256}.json`, 'preview identity')
    }
  }
}
export function validatePlaybackRef(ref: unknown): asserts ref is ObjectRef {
  validateRef(ref)
  assert(ref.path === `playback/${ref.sha256}.json`, 'playback identity')
}
export function validatePlayback(value: unknown): asserts value is PlaybackManifest {
  assert(object(value) && value.schema === 'vandelay.publish.playback/v1' &&
    Array.isArray(value.ranges) && value.ranges.length > 0, 'playback manifest')
  for (const r of value.ranges) {
    assert(object(r) && typeof r.url === 'string' && /^media\/[a-f0-9]{64}\.mp4$/.test(r.url) &&
      Number.isFinite(r.start) && Number.isFinite(r.end) && r.start >= 0 && r.end > r.start, 'media range')
  }
}
export function validatePreview(value: unknown): asserts value is DailyPreview {
  assert(object(value) && value.schema === 'vandelay.publish.preview/v1' && object(value.scope) &&
    /^\d{4}-\d{2}-\d{2}$/.test(value.scope.day) && typeof value.scope.timezone === 'string' &&
    typeof value.scope.start === 'string' && typeof value.scope.end === 'string', 'preview scope/schema')
  assert(Array.isArray(value.highlights) && value.highlights.length <= 3 &&
    Array.isArray(value.timelapses), 'preview collections')
  for (const h of value.highlights)
    assert(object(h) && typeof h.at === 'string' && Number.isFinite(Date.parse(h.at)) &&
      typeof h.anchor === 'string' && typeof h.title === 'string' && typeof h.summary === 'string', 'highlight')
  for (const t of value.timelapses) {
    assert(object(t) && typeof t.source === 'string' && typeof t.label === 'string' &&
      (t.stream === undefined || typeof t.stream === 'string') &&
      (t.poster === undefined || (typeof t.poster === 'string' && /^media\/[a-f0-9]{64}\.webp$/.test(t.poster))), 'preview timelapse')
    validatePlaybackRef(t.playback)
  }
}
function validateAssets(assets: unknown): asserts assets is any[] {
  assert(Array.isArray(assets), 'asset inventory')
  const paths = new Set<string>()
  for (const asset of assets) {
    assert(object(asset) && ['video/mp4', 'image/webp'].includes(asset.mediaType) &&
      typeof asset.recipe === 'string' && Array.isArray(asset.inputs), 'asset metadata')
    const mediaType = asset.mediaType
    validateRef(asset)
    assert(!paths.has(asset.path), 'duplicate asset')
    paths.add(asset.path)
    assert(asset.path === `media/${asset.sha256}.${mediaType === 'video/mp4' ? 'mp4' : 'webp'}`, 'asset identity')
  }
}
export function validateDay(value: unknown): asserts value is PublishedDay {
  assert(object(value) && value.schema === 'vandelay.publish.day/v1', 'day schema')
  assert(object(value.scope) && /^\d{4}-\d{2}-\d{2}$/.test(value.scope.day) &&
    typeof value.scope.timezone === 'string' && typeof value.scope.start === 'string' &&
    typeof value.scope.end === 'string', 'day scope')
  assert(Array.isArray(value.frames) && Array.isArray(value.entries) &&
    Array.isArray(value.sources) && Array.isArray(value.timelapses), 'day collections')
  validateAssets(value.assets)
  const assets = new Map(value.assets.map(a => [a.path, a]))
  const frames = new Map<string, any>()
  for (const f of value.frames) {
    assert(object(f) && typeof f.key === 'string' && typeof f.source === 'string' &&
      typeof f.recordID === 'string' && typeof f.at === 'string' && typeof f.anchor === 'string' &&
      typeof f.previewStatus === 'string' && object(f.time), 'frame')
    assert(!frames.has(f.key), 'duplicate capture')
    frames.set(f.key, f)
    assert(!('href' in f) && (!f.media || !('location' in f.media)), 'consumer route or local path')
    if (f.preview) {
      objectPath(f.preview)
      assert(assets.get(f.preview)?.mediaType === 'image/webp', 'uninventoried preview')
    }
    if (f.playback) {
      objectPath(f.playback.asset)
      assert(assets.get(f.playback.asset)?.mediaType === 'video/mp4', 'uninventoried playback')
      assert(Number.isFinite(f.playback.offset) && f.playback.offset >= 0 &&
        Number.isFinite(f.playback.duration) && f.playback.duration > 0, 'playback range')
    }
  }
  const clip = (c: any) => {
    assert(object(c) && typeof c.label === 'string' && Array.isArray(c.frameKeys) &&
      ['day', 'activity-time-range'].includes(c.selection), 'playlist')
    assert(c.frameKeys.length > 0 && c.frameKeys.every((key: string) => frames.get(key)?.playback), 'unplayable playlist reference')
  }
  const entries = new Set<string>()
  for (const e of value.entries) {
    assert(object(e) && typeof e.source === 'string' && typeof e.recordID === 'string' &&
      typeof e.anchor === 'string' && typeof e.title === 'string' && typeof e.text === 'string' &&
      object(e.time) && object(e.placement) && Array.isArray(e.details) && Array.isArray(e.links) &&
      Array.isArray(e.frameKeys) && Array.isArray(e.apps), 'entry')
    assert(!entries.has(e.anchor) && !('href' in e), 'entry identity')
    entries.add(e.anchor)
    if (e.clip) clip(e.clip)
  }
  for (const t of value.timelapses) {
    assert(object(t) && typeof t.source === 'string', 'day timelapse')
    clip(t.clip)
  }
}
