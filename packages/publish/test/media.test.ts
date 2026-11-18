import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { digest, record, scope } from '@vandelay/ddb/model'
import { projectDay } from '../src/project'
import { prepareMedia, run } from '../src/media'
import { clipPresentation } from '../src/presentation'
import { scan, planMasks, frameID, groupFindings, emptyReview, ReviewedRendition } from '@vandelay/autoredact'

const root = mkdtempSync(join(tmpdir(), 'vandelay-publish-media-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
test.each(['dayflow', 'daycap'] as const)('%s all-capture shared chunks and explicit stride', async type => {
  const path = join(root, `${type}.mp4`)
  await run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
    `testsrc2=size=128x72:rate=${type === 'daycap' ? '1/5' : '1'}:duration=${type === 'daycap' ? 30 : 6}`,
    '-c:v', type === 'daycap' ? 'libx265' : 'libx264',
    ...(type === 'daycap' ? [
      '-x265-params', 'bframes=0:keyint=1:pools=1:frame-threads=1:log-level=error',
      '-tag:v', 'hvc1', '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-video_track_timescale', '1000000',
    ] : []), '-threads', '1', '-pix_fmt', 'yuv420p', '-y', path])
  const bytes = readFileSync(path), hash = digest(bytes), bounds = scope('2026-11-14', 'UTC')
  const make = () => projectDay([{
    path: 'manifest', sha256: 'a'.repeat(64), evidence: {},
    manifest: {
      schema: 'vandelay.bundle/v1', record_schema: 'vandelay.record/v1', scope: bounds,
      producer: { name: 'fixture', version: '1', adapter: `${type}/3` },
      files: {}, source: { type, instance: 'fixture' },
      coverage: { state: 'observed', method: 'fixture', limitations: [] }, record_count: 8,
    },
    records: [
      ...Array.from({ length: 6 }, (_, i) => record({
        id: `capture:${i}`, kind: type === 'daycap' ? 'daycap.capture' : 'dayflow.screenshots',
        time: { model: 'instant', at: `2026-11-14T00:00:0${i}Z`, basis: 'capture' },
        data: { frame_index: i },
        media: [{
          role: 'capture', sha256: hash, bytes: bytes.length,
          location: { kind: 'archive-relative', path: `${type}.mp4` },
          ...(type === 'daycap' ? { selector: {
            type: 'video-frame' as const, frame_index: i,
            presentation: { value: String(i * 5000000), timescale: 1000000 },
            duration: { value: '5000000', timescale: 1000000 },
          } } : {}),
        }],
      }, bounds)!),
      ...[0, 1].map(i => record({
        id: `card:${i}`, kind: type === 'daycap' ? 'daycap.journal.activity' : 'dayflow.timeline_cards',
        time: { model: 'interval', start: `2026-11-14T00:00:0${i}Z`, end: '2026-11-14T00:00:04Z', basis: 'source' },
        data: { summary: 'Test clip', relations: [{
          relation: 'supports', target: { source: { type, instance: 'fixture' }, id: 'capture:0' },
        }] },
      }, bounds)!),
    ],
  }], bounds)
  const day = make(), cache = join(root, `cache-${type}`)
  const assets = await prepareMedia([day], root, cache, true)
  expect(assets.filter(a => a.mediaType === 'video/mp4')).toHaveLength(1)
  expect(day.timelapses[0].clip.frameKeys).toHaveLength(6)
  expect(day.entries.map(e => e.clip!.frameKeys.length)).toEqual([4, 3])
  expect(new Set(day.frames.map(f => f.playback!.asset)).size).toBe(1)
  expect(day.frames.map(f => f.playback!.offset)).toEqual([0, .25, .5, .75, 1, 1.25])
  const movie = assets.find(a => a.mediaType === 'video/mp4')!
  expect(movie.inputs.map(f => f.frameIndex)).toEqual([0, 1, 2, 3, 4, 5])
  const decoded = JSON.parse(await run(['ffprobe', '-v', 'error', '-count_frames',
    '-show_entries', 'stream=nb_read_frames,codec_name,duration', '-of', 'json', join(cache, movie.path)]))
  expect(decoded.streams[0]).toMatchObject({ codec_name: 'h264', nb_read_frames: '6', duration: '1.500000' })
  await expectSameCaptures(path, join(cache, movie.path), 6)
  expect(await prepareMedia([make()], root, cache, true)).toEqual(assets)
  const aliased = make()
  writeFileSync(join(root, `alias-${type}.mp4`), bytes)
  aliased.frames.push({
    ...aliased.frames[1], key: 'alias-capture', recordID: 'alias-capture',
    media: { ...aliased.frames[1].media!, location: { kind: 'archive-relative', path: `alias-${type}.mp4` } },
  })
  const aliasAssets = await prepareMedia([aliased], root, cache, true)
  expect(aliasAssets.filter(a => a.mediaType === 'video/mp4')).toHaveLength(1)
  expect(aliased.frames.at(-1)!.playback).toEqual(aliased.frames[1].playback)
  writeFileSync(join(cache, movie.path), 'broken')
  await prepareMedia([make()], root, cache, true)
  expect(digest(readFileSync(join(cache, movie.path)))).toBe(movie.sha256)
  for (const stride of [2, 3, 4]) {
    const sampled = make()
    const output = await prepareMedia([sampled], root, cache, true, stride)
    expect(output.find(a => a.mediaType === 'video/mp4')!.inputs.map(f => f.frameIndex))
      .toEqual([0, 1, 2, 3, 4, 5].filter(i => i % stride === 0))
    expect(sampled.timelapses[0].clip.frameKeys.length).toBe(Math.ceil(6 / stride))
  }
  const wrong = make()
  wrong.frames[0].presentation = { value: '99', timescale: 1 }
  await expect(prepareMedia([wrong], root, cache, true)).rejects.toThrow('PTS disagreement')
  const withheld = make()
  withheld.entries[0].status = 'withheld'
  await prepareMedia([withheld], root, cache, true)
  expect(withheld.entries[0].clip).toBeUndefined()
  const missing = make()
  for (const f of missing.frames) f.media!.location = { kind: 'archive-relative', path: 'missing.mp4' }
  expect(await prepareMedia([missing], root, cache, true)).toEqual([])
  expect(missing.frames[0].previewStatus).toContain('missing')
  if (type === 'daycap') expect(bytes.includes(Buffer.from('moof'))).toBe(true)
  const report = await scan([path], { ocr: async () => ({
    recognize: async () => ({ width: 128, height: 72, lines: [{ text: 'same label', box: [0, 0, 1, 1], confidence: 1 }] }),
    close: async () => {},
  }) })
  const reportHash = digest(JSON.stringify(report)), review = emptyReview(reportHash)
  review.maskPlan = planMasks(report, undefined, frameID(report.frames![0].source, 0), [{
    box: [0, 0, 1, 1], anchor: report.frames![0].regions[0], scope: { start: 0, end: 5 },
  }])
  review.schema = 'autoredact.review/v2'
  for (const group of groupFindings(report)) review.decisions[group.id] = {
    decision: group.frame === 1 ? 'withhold' : 'publish', note: '', updatedAt: new Date().toISOString(),
  }
  const rendition = new ReviewedRendition(report, review, reportHash, digest(JSON.stringify(review)))
  const masked = make()
  const rendered = await prepareMedia([masked], root, cache, true, 1, rendition)
  expect(masked.frames[1].playback).toBeUndefined()
  const maskedMovie = rendered.find(a => a.mediaType === 'video/mp4')!
  expect(maskedMovie.sha256).not.toBe(movie.sha256)
  expect(maskedMovie.inputs.map(f => f.frameIndex)).toEqual([0, 2, 3, 4, 5])
  expect(maskedMovie.recipe).toContain(rendition.digest)
  for (const asset of rendered) {
    const decoder = Bun.spawn(['ffmpeg', '-v', 'error', '-i', join(cache, asset.path),
      '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { stdout: 'pipe', stderr: 'pipe' })
    const rgb = new Uint8Array(await new Response(decoder.stdout).arrayBuffer())
    expect(await decoder.exited).toBe(0)
    expect([...rgb].every(v => v < 8)).toBe(true)
  }
  expect(await prepareMedia([make()], root, cache, true, 1, rendition)).toEqual(rendered)
  writeFileSync(path, 'changed source')
  await expect(prepareMedia([make()], root, cache, true)).rejects.toThrow('hash/size mismatch')
}, 60000)

async function pixels(path: string) {
  const child = Bun.spawn(['ffmpeg', '-v', 'error', '-i', path, '-vf', 'scale=64:36',
    '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
  { stdout: 'pipe', stderr: 'pipe' })
  const [bytes, stderr, status] = await Promise.all([
    new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited,
  ])
  if (status) throw new Error(stderr)
  return new Uint8Array(bytes)
}

async function expectSameCaptures(source: string, output: string, count: number) {
  const [expected, actual] = await Promise.all([pixels(source), pixels(output)])
  expect(actual.length).toBe(count * 64 * 36 * 3)
  expect(expected.length).toBe(actual.length)
  for (let frame = 0; frame < count; frame++) {
    let error = 0
    const size = 64 * 36 * 3
    for (let i = frame * size; i < (frame + 1) * size; i++)
      error += Math.abs(expected[i] - actual[i])
    expect(error / size).toBeLessThan(5)
  }
}

test('Daycap packs across source objects to 60s, preserving offsets and boundaries', async () => {
  const bounds = scope('2026-11-14', 'UTC')
  const frames: import('../src/model').Frame[] = []
  for (let source = 0; source < 2; source++) {
    const path = `long-${source}.mp4`
    await run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
      `color=c=${source ? 'blue' : 'red'}:size=128x72:rate=1/5:duration=605`,
      '-c:v', 'libx264', '-threads', '1', '-y', join(root, path)])
    const bytes = readFileSync(join(root, path)), hash = digest(bytes)
    for (let i = 0; i < 120; i++) {
      const ordinal = source * 120 + i
      const at = new Date(Date.parse(bounds.start) + ordinal * 5000).toISOString()
      frames.push({
        key: `long-${ordinal}`, anchor: `long-${ordinal}`, recordID: `long-${ordinal}`,
        source: 'daycap/fixture', stream: 'screen', session: 'session',
        at, time: { model: 'instant', at, basis: 'capture' }, disposition: 'captured',
        previewStatus: '', frameIndex: i,
        presentation: { value: String(i * 5000000), timescale: 1000000 },
        media: { role: 'capture', sha256: hash, bytes: bytes.length,
          location: { kind: 'archive-relative', path } },
      })
    }
  }
  const make = () => ({
    schema: 'vandelay.publish.day/v1' as const, scope: bounds, sources: [],
    entries: [], timelapses: [], frames: structuredClone(frames),
  })
  const cache = join(root, 'long-cache'), day = make()
  const assets = await prepareMedia([day], root, cache, true)
  const movies = assets.filter(a => a.mediaType === 'video/mp4')
  expect(movies).toHaveLength(1)
  expect(new Set(movies[0].inputs.map(i => i.sha256)).size).toBe(2)
  expect(movies[0].inputs.map(i => i.outputFrame)).toEqual(Array.from({ length: 240 }, (_, i) => i))
  expect(day.frames[120].playback!.offset).toBe(30)
  expect(day.frames[239].playback!.offset).toBe(59.75)
  const clip = clipPresentation({
    label: 'Across source boundary', selection: 'activity-time-range',
    frameKeys: day.frames.slice(118, 122).map(f => f.key),
  }, new Map(day.frames.map(f => [f.key, f])))
  expect(clip.map.ranges).toEqual([{ url: movies[0].path, start: 29.5, end: 30.5 }])
  const output = await pixels(join(cache, movies[0].path))
  expect(output.length).toBe(240 * 64 * 36 * 3)
  for (const frame of [0, 119, 120, 239]) {
    const offset = frame * 64 * 36 * 3
    expect(output[offset + (frame < 120 ? 0 : 2)]).toBeGreaterThan(240)
    expect(output[offset + (frame < 120 ? 2 : 0)]).toBeLessThan(10)
  }
  expect(await prepareMedia([make()], root, cache, true)).toEqual(assets)
  const overflow = make()
  const at = new Date(Date.parse(bounds.start) + 1200000).toISOString()
  overflow.frames.push({
    ...structuredClone(frames[239]), key: 'overflow', recordID: 'overflow', anchor: 'overflow',
    frameIndex: 120, presentation: { value: '600000000', timescale: 1000000 },
    at, time: { model: 'instant', at, basis: 'capture' },
  })
  overflow.frames.push({ ...overflow.frames[0], key: 'alias', recordID: 'alias', anchor: 'alias' })
  const overflowAssets = await prepareMedia([overflow], root, cache, true)
  expect(overflowAssets.filter(a => a.mediaType === 'video/mp4').map(a => a.inputs.length).sort((a, b) => a - b))
    .toEqual([1, 240])
  expect(overflow.frames[240].playback!.offset).toBe(0)
  expect(overflow.frames[240].playback!.asset).not.toBe(movies[0].path)
  expect(overflow.frames[241].playback).toEqual(overflow.frames[0].playback)
  const sampled = make()
  const sampledAssets = await prepareMedia([sampled], root, cache, true, 4)
  expect(sampledAssets.filter(a => a.mediaType === 'video/mp4')).toHaveLength(1)
  expect(sampled.frames[236].playback!.offset).toBe(14.75)
  expect(sampled.frames[1].playback).toBeUndefined()
  for (const boundary of ['gap', 'session', 'stream', 'day'] as const) {
    const split = make()
    for (const f of split.frames.slice(120)) {
      if (boundary === 'gap') f.at = new Date(Date.parse(f.at) + 60000).toISOString()
      if (boundary === 'session') f.session = 'other'
      if (boundary === 'stream') f.stream = 'other'
    }
    const days = boundary === 'day'
      ? [{ ...split, frames: split.frames.slice(0, 120) }, { ...split, frames: split.frames.slice(120) }]
      : [split]
    const result = await prepareMedia(days, root, cache, true)
    expect(result.filter(a => a.mediaType === 'video/mp4')).toHaveLength(2)
  }
}, 120000)
