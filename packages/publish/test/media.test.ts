import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { digest, record, scope } from '@vandelay/ddb/model'
import { projectDay } from '../src/project'
import { prepareMedia, run } from '../src/media'

const root = mkdtempSync(join(tmpdir(), 'vandelay-publish-media-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
test.each(['dayflow', 'daycap'] as const)('%s all-capture shared chunks and explicit stride', async type => {
  const path = join(root, `${type}.mp4`)
  await run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=128x72:rate=1:duration=6',
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
            presentation: { value: String(i * 1000000), timescale: 1000000 },
            duration: { value: '1000000', timescale: 1000000 },
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
  writeFileSync(path, 'changed source')
  await expect(prepareMedia([make()], root, cache, true)).rejects.toThrow('hash/size mismatch')
}, 60000)
