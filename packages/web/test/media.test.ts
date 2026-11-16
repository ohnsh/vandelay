import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { digest, record, scope } from '@vandelay/ddb/model'
import { projectDay } from '../src/lib/project'
import { prepareMedia, run } from '../scripts/media'
import { rejects } from 'node:assert/strict'

const root = mkdtempSync(join(tmpdir(), 'vandelay-web-media-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
test('exact frames, playback map, cache integrity, missing media and mismatched selectors', async () => {
  await run([
    'ffmpeg',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=128x72:rate=1:duration=3',
    '-c:v',
    'libx264',
    '-threads',
    '1',
    '-pix_fmt',
    'yuv420p',
    '-y',
    join(root, 'source.mp4'),
  ])
  const source = readFileSync(join(root, 'source.mp4'))
  const bounds = scope('2026-11-14', 'UTC')
  const make = () => {
    const records = [0, 2].map((i) =>
      record(
        {
          id: `screenshots:${i}`,
          kind: 'dayflow.screenshots',
          time: { model: 'instant', at: `2026-11-14T00:00:0${i}Z`, basis: 'capture' },
          data: { frame_index: i },
          media: [
            {
              role: 'capture',
              sha256: digest(source),
              bytes: source.length,
              location: { kind: 'archive-relative', path: 'source.mp4' },
            },
          ],
        },
        bounds,
      )!,
    )
    records.push(
      record(
        {
          id: 'card',
          kind: 'dayflow.timeline_cards',
          time: {
            model: 'interval',
            start: '2026-11-14T00:00:00Z',
            end: '2026-11-14T00:00:03Z',
            basis: 'source-asserted-interval',
          },
          data: { summary: 'Test clip' },
        },
        bounds,
      )!,
    )
    return projectDay(
      [
        {
          records,
          path: 'manifest',
          sha256: 'a'.repeat(64),
          evidence: {},
          manifest: {
            schema: 'vandelay.bundle/v1',
            record_schema: 'vandelay.record/v1',
            scope: bounds,
            producer: { name: 'fixture', version: '1', adapter: 'dayflow/2' },
            files: {},
            source: { type: 'dayflow', instance: 'fixture' },
            coverage: { state: 'observed', method: 'fixture', limitations: [] },
            record_count: records.length,
          },
        },
      ],
      bounds,
    )
  }
  const cache = join(root, 'cache'),
    day = make()
  const assets = await prepareMedia([day], root, cache, true)
  expect(assets.filter((a) => a.path.endsWith('.webp'))).toHaveLength(2)
  expect(assets.filter((a) => a.path.endsWith('.mp4'))).toHaveLength(1)
  expect(day.entries[0].clip?.frames.map((f) => [f.offset, f.at, f.gap])).toEqual([
    [0, '2026-11-14T00:00:00.000000Z', false],
    [0.5, '2026-11-14T00:00:02.000000Z', true],
  ])
  expect(day.frames[0].preview).not.toBe(day.frames[1].preview)
  const replay = await prepareMedia([make()], root, cache, true)
  expect(replay).toEqual(assets)
  const damaged = join(cache, day.frames[0].preview!.split('/').at(-1)!)
  writeFileSync(damaged, 'corrupt derivative')
  await prepareMedia([make()], root, cache, true)
  expect(digest(readFileSync(damaged))).toBe(
    assets.find((a) => a.path === day.frames[0].preview)!.sha256,
  )
  const wrong = make()
  wrong.frames[0].presentation = { value: '99', timescale: 1 }
  await rejects(prepareMedia([wrong], root, cache, true), /PTS disagreement/)
  const missing = make()
  for (const f of missing.frames)
    f.media!.location = { kind: 'archive-relative', path: 'missing.mp4' }
  expect(await prepareMedia([missing], root, cache, true)).toEqual([])
  expect(missing.frames[0].previewStatus).toContain('missing')
  writeFileSync(join(root, 'source.mp4'), 'changed source')
  await rejects(prepareMedia([make()], root, cache, true), /hash\/size mismatch/)
}, 30000)
