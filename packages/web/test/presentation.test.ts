import { expect, test } from 'bun:test'
import type { PublishedDay } from '@vandelay/publish/model'
import { scope } from '@vandelay/ddb/model'
import { presentDay } from '../src/lib/presentation'
import { playbackRanges } from '../src/lib/playback'
import { withBase } from '../src/lib/model'

test('consumer-owned routes, shared playlist assets, and contiguous playback ranges', () => {
  const day: PublishedDay = {
    schema: 'vandelay.publish.day/v1', scope: scope('2026-11-14', 'UTC'), sources: [], entries: [], assets: [],
    frames: [0, 1, 2, 3].map(i => ({
      key: `frame-${i}`, anchor: `anchor-${i}`, source: 'daycap/desktop', recordID: `capture/${i}`,
      at: `2026-11-14T00:00:0${i}Z`, time: { model: 'instant', at: `2026-11-14T00:00:0${i}Z`, basis: 'capture' },
      disposition: 'captured', previewStatus: 'prepared',
      playback: { asset: i < 3 ? 'media/a.mp4' : 'media/b.mp4', offset: i < 3 ? i * .25 : 0, duration: .25 },
    })),
    timelapses: [{ source: 'daycap/desktop', clip: {
      label: 'All captures', selection: 'day', frameKeys: ['frame-0', 'frame-1', 'frame-2', 'frame-3'],
    } }],
  }
  const view = presentDay(day, 'https://media.example.test/archive/')
  expect(view.frames[0].href).toBe('/frames/2026-11-14/daycap/desktop/1/#anchor-0')
  const clip = view.timelapses[0].clip
  expect(playbackRanges(clip)).toEqual([
    { url: 'https://media.example.test/archive/media/a.mp4', start: 0, end: .75, first: 0, last: 2 },
    { url: 'https://media.example.test/archive/media/b.mp4', start: 0, end: .25, first: 3, last: 3 },
  ])
  expect(playbackRanges({ ...clip, frames: [clip.frames[0], clip.frames[2]] })).toHaveLength(2)
  expect(withBase(clip.frames[0].url, '/nested/')).toBe(clip.frames[0].url)
  expect(withBase(view.frames[0].href, '/nested/')).toStartWith('/nested/frames/')
  expect(JSON.stringify(day)).not.toContain('https://media')
})
