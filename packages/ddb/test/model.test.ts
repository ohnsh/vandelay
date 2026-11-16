import { expect, test } from 'bun:test'
import {
  compareRecords, encode, instant, intervalTime, normalizeTime, record, scope,
  validateRecord, type RecordTime,
} from '../src/model.ts'

const bounds = scope('2026-11-12', 'America/Chicago')
const make = (time: RecordTime, id = 'fixture') => record({ id, kind: 'fixture', time }, bounds)

test('instant membership is half-open, canonical, and has no invented duration', () => {
  const item = make({ model: 'instant', at: '2026-11-12T00:00:00-06:00', basis: 'sent-at' })!
  expect(item.time).toEqual({ model: 'instant', at: bounds.start, basis: 'sent-at' })
  expect(item.placement).toEqual({ model: 'instant', at: bounds.start })
  expect('start' in item).toBe(false)
  expect('visible' in item).toBe(false)
  expect(make({ model: 'instant', at: bounds.end, basis: 'sent-at' })).toBeNull()
  expect(() => validateRecord(JSON.parse(encode(item).toString()), bounds)).not.toThrow()
  expect(() => normalizeTime({ model: 'instant', at: '2026-11-12T06:00:00.1234567Z', basis: 'sent-at' }))
    .toThrow('microsecond')
})

test('interval clipping preserves source time across midnight and DST', () => {
  for (const date of ['2026-03-08', '2026-11-01']) {
    const day = scope(date, 'America/Chicago')
    const time: RecordTime = {
      model: 'interval',
      start: instant(day.start).subtract({ hours: 1 }).toString(),
      end: instant(day.end).add({ hours: 1 }).toString(),
      basis: 'recording-clock',
    }
    const item = record({ id: 'recording', kind: 'vod.recording', time }, day)!
    expect(item.placement).toEqual({ model: 'interval', start: day.start, end: day.end })
    expect(item.time).toEqual(normalizeTime(time))
    expect(() => validateRecord(item, day)).not.toThrow()
  }
  expect(make({ model: 'interval', start: '2026-11-12T05:00:00Z', end: bounds.start, basis: 'fixture' })).toBeNull()
  expect(() => make({ model: 'interval', start: bounds.start, end: bounds.start, basis: 'fixture' })).toThrow('positive')
  expect(() => make({ model: 'interval', start: bounds.end, end: bounds.start, basis: 'fixture' })).toThrow('positive')
  expect(intervalTime(instant(bounds.start), instant(bounds.start), 'source-point').model).toBe('instant')
})

test('capture and sample bounds retain their semantics rather than becoming durations', () => {
  for (const basis of ['capture-request-completion', 'sample-envelope']) {
    const item = make({ model: 'bounds', start: bounds.start, end: '2026-11-12T06:00:00.123456Z', basis })!
    expect(item.time.model).toBe('bounds')
    expect(item.placement.model).toBe('bounds')
    expect(() => validateRecord(item, bounds)).not.toThrow()
  }
  const point = make({ model: 'bounds', start: bounds.start, end: bounds.start, basis: 'capture-request-completion' })!
  expect(point.time.model).toBe('bounds')
  expect(make({ model: 'bounds', start: bounds.end, end: bounds.end, basis: 'fixture' })).toBeNull()
})

test('calendar association is stable across bundles and never masquerades as a day-long event', () => {
  const time: RecordTime = {
    model: 'day', associations: [
      { day: '2026-11-13', timezone: bounds.timezone, role: 'report-day' },
      { day: bounds.day, timezone: bounds.timezone, role: 'source-day' },
    ],
  }
  const previous = make(time)!
  const next = record({ id: 'fixture', kind: 'fixture', time }, scope('2026-11-13', bounds.timezone))!
  expect(previous.time).toEqual(next.time)
  expect(previous.placement).toEqual({ model: 'day', roles: ['source-day'] })
  expect(next.placement).toEqual({ model: 'day', roles: ['report-day'] })
  expect(record({ id: 'fixture', kind: 'fixture', time }, scope(bounds.day, 'UTC'))).toBeNull()
  expect(() => normalizeTime({ model: 'day', associations: [...time.associations, time.associations[0]] }))
    .toThrow('Duplicate')
  expect(() => normalizeTime({ model: 'day', associations: [{ day: '2026-02-30', timezone: 'UTC', role: 'report-day' }] })).toThrow()
})

test('unknown event time needs explicit day association and sorts after timed content', () => {
  const item = make({
    model: 'unknown', reason: 'Attachment has no independent event timestamp',
    associations: [{ day: bounds.day, timezone: bounds.timezone, role: 'parent-message-day' }],
  })!
  expect(item.placement).toEqual({ model: 'unknown', roles: ['parent-message-day'] })
  expect('start' in item.time).toBe(false)
  const point = make({ model: 'instant', at: bounds.start, basis: 'sent-at' })!
  expect([item, point].sort(compareRecords)).toEqual([point, item])
  expect(() => normalizeTime({ model: 'unknown', reason: 'missing', associations: [] })).toThrow('associations')
})

test('runtime validation rejects ambiguous unions, reserved fields and fabricated placement', () => {
  const time: RecordTime = { model: 'instant', at: bounds.start, basis: 'capture-timestamp' }
  const item = make(time)!
  expect(() => normalizeTime({ ...time, end: bounds.end })).toThrow('Unexpected')
  expect(() => normalizeTime({ model: 'later', at: bounds.start })).toThrow('Unknown')
  expect(() => record({ id: 'x', kind: 'fixture', time, schema: 'override' } as any, bounds)).toThrow('Unexpected')
  expect(() => validateRecord({ ...item, start: bounds.start }, bounds)).toThrow('Unexpected')
  expect(() => validateRecord({ ...item, placement: { model: 'instant', at: bounds.end } }, bounds)).toThrow('placement')
  expect(() => validateRecord({ ...item, time: { ...time, basis: '' } }, bounds)).toThrow('nonempty')
  expect(() => validateRecord({ ...item, schema: 'future' }, bounds)).toThrow('schema')
  expect(() => validateRecord({ ...item, text: 123 }, bounds)).toThrow('text')
  expect(record({ id: 'x', kind: 'email.message', time, data: { schema: 'source-owned', start: 'raw value' } }, bounds)?.data)
    .toEqual({ schema: 'source-owned', start: 'raw value' })
})
