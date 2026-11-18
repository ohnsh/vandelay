import { describe, expect, test } from 'bun:test'
import { record, scope, type ArchiveRecord, type RecordInput } from '@vandelay/ddb/model'
import { anchor, identity, projectDay, type Bundle } from '../src/project'

const bounds = scope('2026-11-01', 'America/Chicago') // 25-hour fall-back day
const input = (
  partial: Partial<RecordInput> & Pick<RecordInput, 'id' | 'kind'>,
): ArchiveRecord =>
  record(
    { time: { model: 'instant', at: '2026-11-01T06:30:00Z', basis: 'test' }, ...partial },
    bounds,
  )!
export function bundle(
  type: Bundle['manifest']['source']['type'],
  records: ArchiveRecord[],
  evidence = {},
): Bundle {
  return {
    path: 'manifest.json',
    sha256: 'a'.repeat(64),
    evidence,
    records,
    manifest: {
      schema: 'vandelay.bundle/v1',
      record_schema: 'vandelay.record/v1',
      scope: bounds,
      source: { type, instance: 'fixture' },
      producer: { name: 'fixture', version: '1', adapter: `${type}/2` },
      record_count: records.length,
      files: {},
      coverage: { state: 'observed', method: 'fixture', limitations: [] },
    },
  }
}
describe('publication semantics', () => {
  test('pins citations to exact revisions; current rendition is a separate playback choice', () => {
    const ref = {
      source: { type: 'daycap', instance: 'fixture' },
      id: 'capture/a',
      revision: '1',
    }
    const capture = input({
      id: ref.id,
      kind: 'daycap.capture',
      data: { revision: '2', status: 'active', capture: { disposition: 'captured' } },
    })
    const time = {
      model: 'bounds' as const,
      start: '2026-11-01T06:30:00Z',
      end: '2026-11-01T07:30:00Z',
      basis: 'sample-envelope',
    }
    const activity = input({
      id: 'card/a',
      kind: 'daycap.journal.activity',
      time,
      data: {
        details: [{ id: 'detail/a', text: 'Cited work', time, supports: [ref] }],
        relations: [{ relation: 'supports', target: ref }],
      },
    })
    const b = bundle('daycap', [capture, activity])
    b.references = { entries: [{ target: ref, resolution: { status: 'evidence-only' } }] }
    const day = projectDay([b], bounds),
      e = day.entries[0]
    expect(e.details[0].supports[0].target).toBeUndefined()
    expect(e.details[0].supports[0].status).toBe('evidence-only')
    expect(e.frameKeys).toEqual([identity('daycap/fixture', ref.id)])
    expect(e.time.model).toBe('bounds')
    expect(e.attribution).toContain('current media may differ')
  })
  test('Dayflow prose stays unstructured and time-selected frames are not citations', () => {
    const screenshot = input({
      id: 'screenshots:1',
      kind: 'dayflow.screenshots',
      data: { frame_index: 3, batch_ids: [12] },
    })
    const activity = input({
      id: 'timeline_cards:1',
      kind: 'dayflow.timeline_cards',
      time: {
        model: 'interval',
        start: '2026-11-01T06:00:00Z',
        end: '2026-11-01T07:00:00Z',
        basis: 'source-asserted-interval',
      },
      data: {
        batch_id: 99,
        summary: 'Summary',
        detailed_summary: '1:30 AM - 1:40 AM: source prose',
      },
    })
    const d = projectDay([bundle('dayflow', [screenshot, activity])], bounds)
    expect(d.entries[0].frameKeys).toHaveLength(1)
    expect(d.entries[0].details[0].time).toBeUndefined()
    expect(d.entries[0].details[0].supports).toEqual([])
    expect(d.entries[0].attribution).toContain('selected by time')
    expect(d.frames[0].presentation).toEqual({ value: '3', timescale: 1 })
  })
  test('retains DST scope, clipped placement, calendar reports and unknown time', () => {
    const interval = input({
      id: 'event:1',
      kind: 'activitywatch.currentwindow',
      time: {
        model: 'interval',
        start: '2026-11-01T04:00:00Z',
        end: '2026-11-01T06:00:00Z',
        basis: 'source-reported-duration',
      },
    })
    const associations = [
      { day: bounds.day, timezone: bounds.timezone, role: 'report-day' },
    ]
    const report = input({
      id: 'report',
      kind: 'dayflow.report',
      time: { model: 'day', associations },
    })
    const unknown = input({
      id: 'unknown',
      kind: 'source.attachment',
      time: { model: 'unknown', reason: 'No timestamp', associations },
    })
    const d = projectDay(
      [bundle('activitywatch', [interval]), bundle('dayflow', [report, unknown])],
      bounds,
    )
    expect((Date.parse(d.scope.end) - Date.parse(d.scope.start)) / 3600000).toBe(25)
    expect(d.entries[0].placement).toMatchObject({ start: bounds.start })
    expect(d.entries[0].time).toMatchObject({ start: '2026-11-01T04:00:00.000000Z' })
    expect(d.entries.find((e) => e.recordID === 'report')!.placement).toEqual({
      model: 'day',
      roles: ['report-day'],
    })
    expect(d.entries.find((e) => e.recordID === 'unknown')!.time.model).toBe('unknown')
  })
  test('withdrawn payloads cannot expose stale narrative, media or foreground labels', () => {
    const b = bundle(
      'daycap',
      [
        input({
          id: 'capture/a',
          kind: 'daycap.capture',
          data: { status: 'withdrawn', capture: { disposition: 'captured' } },
          evidence: { file: 'evidence.json', pointer: '/observations/0' },
          media: [
            {
              role: 'capture',
              sha256: 'a'.repeat(64),
              bytes: 1,
              location: { kind: 'archive-relative', path: 'object' },
            },
          ],
        }),
        input({
          id: 'card/a',
          kind: 'daycap.journal.activity',
          title: 'Stale title',
          text: 'Stale summary',
          data: { status: 'withdrawn', details: [{ text: 'Stale detail' }] },
        }),
      ],
      {
        observations: [
          {
            applicationState: {
              foregroundChanged: false,
              foregroundBefore: { name: 'Stale app' },
            },
          },
        ],
      },
    )
    const d = projectDay([b], bounds)
    expect(d.frames[0].media).toBeUndefined()
    expect(d.frames[0].app).toBeUndefined()
    expect(d.entries[0].text).toBe('')
    expect(d.entries[0].details).toEqual([])
    expect(d.entries[0].title).not.toContain('Stale')
  })
  test('source identities cannot collide and unsafe-looking titles stay prose', () => {
    const value = input({
      id: 'same/id',
      kind: 'activitywatch.currentwindow',
      title: '<script>not markup</script>',
    })
    const d = projectDay(
      [
        bundle('activitywatch', [value]),
        bundle('dayflow', [{ ...value, kind: 'dayflow.observations' }]),
      ],
      bounds,
    )
    expect(new Set(d.entries.map((e) => e.anchor)).size).toBe(2)
    expect(anchor('a/b', 'c')).not.toBe(anchor('a', 'b/c'))
    expect(d.entries[0].title).toBe(value.title!)
  })
})
