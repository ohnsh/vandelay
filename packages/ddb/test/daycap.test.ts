import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { daycap, daycapReferences, milliseconds, type DaycapPayload } from '../src/daycap.ts'
import { command } from '../src/io.ts'
import { digest, encode, scope } from '../src/model.ts'
import { Repository } from '../src/repository.ts'

let root: string, directory: string, archive: string
const bounds = scope('2026-11-14', 'UTC')
const start = Date.parse(bounds.start)
const movie = Buffer.from('synthetic media bytes; decoding is not required for archival')
const hash = digest(movie), oldHash = digest('old segment'), policy = digest('policy')
const video = { segmentHash: hash, frameIndex: 0, presentationMicroseconds: 123456 }
function capture(identity: string, at = start + 1000) {
  return {
    id: identity, sessionID: 'session', display: { id: 'display', width: 100, height: 100 },
    sequence: 1, requestedAt: at, completedAt: at + 100, requestedMonotonic: 1, completedMonotonic: 1.1,
    disposition: 'captured', revision: 2, video, policyHash: policy,
    captureMode: 'journal', streamID: 'active', ocrPerformed: false, privacyFiltered: false,
  }
}
function sample(identity: string, at = start + 1000) {
  return {
    id: identity, revision: 1, displayID: 'display', streamID: 'active', runID: 'run',
    requestedAt: at, completedAt: at + 100, width: 100, height: 100,
    video: { ...video, segmentHash: oldHash }, submittedPNGHash: digest('submitted PNG'),
    submittedMasks: [],
  }
}
function batch(identity = 'batch', at = start + 1000, sampleID = 'one') {
  return {
    id: identity, start: at, end: at + 100, createdAt: at, updatedAt: at + 200,
    status: 'complete', attempts: 2, model: 'fixture-model', promptVersion: 'journal-v1',
    sourceIDs: [sampleID], samples: [sample(sampleID, at)], gaps: [],
    context: [] as { id: string; batchID: string; title: string; summary: string; lastSampleAt: number }[],
    output: {
      frames: [{ sampleID, app: 'Editor', note: 'Read code', confidence: 'high' }],
      cards: [{
        id: 'c1', title: 'Review', summary: 'Reviewed code', category: 'work', confidence: 'high',
        continuationOf: null as string | null,
        details: [{ id: 'd1', text: 'Read the collector', sampleIDs: [sampleID] }],
      }],
    },
  }
}
function fixture() {
  return {
    schema: 'daycap.export/v2', id: 'export', producer: 'daycap/0.1.0',
    from: start, to: start + 86400000, timezone: 'UTC',
    observations: [capture('one')], journal: [batch()],
    analyses: [] as unknown[], withdrawals: [] as unknown[],
    objects: [{ path: `objects/${hash}.mp4`, sha256: hash, bytes: movie.length }],
  }
}
function write(source: unknown, transform = (text: string) => text) {
  const bytes = Buffer.from(transform(JSON.stringify(source, null, 2)))
  writeFileSync(join(directory, 'manifest.json'), bytes)
  writeFileSync(join(directory, 'manifest.sha256'), `${digest(bytes)}  manifest.json\n`)
  return bytes
}
function collect() { return daycap(bounds, directory, 'desktop', archive) }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vandelay-daycap-'))
  directory = join(root, 'export'); archive = join(root, 'media')
  mkdirSync(join(directory, 'objects'), { recursive: true })
  writeFileSync(join(directory, `objects/${hash}.mp4`), movie)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

test('v2 collection preserves exact evidence and separates current media from submission inputs', () => {
  const bytes = write(fixture()), result = collect()
  expect(result.evidenceBytes!.equals(bytes)).toBe(true)
  expect(result.records).toHaveLength(4)
  const capture = result.records.find(r => r.kind === 'daycap.capture')!
  expect(capture.time).toEqual({
    model: 'bounds', start: '2026-11-14T00:00:01.000000Z',
    end: '2026-11-14T00:00:01.100000Z', basis: 'capture-request-completion',
  })
  expect(capture.media![0].sha256).toBe(hash)
  expect(capture.media![0].selector!.presentation).toEqual({ value: '123456', timescale: 1000000 })
  expect(readFileSync(join(archive, `sha256/${hash.slice(0, 2)}/${hash}`))).toEqual(movie)
  const analysis = result.records.find(r => r.kind === 'daycap.journal.analysis')!
  expect(analysis.data).toMatchObject({
    inputs: [{
      capture: { revision: '1' },
      archived_at_submission: { availability: 'referenced', sha256: oldHash },
      submitted_image: { availability: 'not-retained', sha256: digest('submitted PNG') },
    }],
  })
  const index = daycapReferences(bytes, result.records, 'desktop')
  expect(index).toMatchObject({
    entries: expect.arrayContaining([
      { target: { source: { type: 'daycap', instance: 'desktop' }, id: 'capture/one', revision: '1' },
        resolution: { status: 'evidence-only', evidence: { file: 'evidence.json', pointer: '/journal/0/samples/0' } } },
      { target: { source: { type: 'daycap', instance: 'desktop' }, id: 'capture/one', revision: '2' },
        resolution: { status: 'included', file: 'records.jsonl' } },
    ]),
  })
  expect(encode(collect().records)).toEqual(encode(result.records))
})

test('decimal milliseconds retain numeric lexemes and round microsecond ties to even', () => {
  expect(milliseconds('0.0005')).toBe('1970-01-01T00:00:00.000000Z')
  expect(milliseconds('0.0015')).toBe('1970-01-01T00:00:00.000002Z')
  expect(milliseconds('-0.0015')).toBe('1969-12-31T23:59:59.999998Z')
  expect(milliseconds('1.5e-3')).toBe(milliseconds('0.0015'))
  const f = fixture(); f.journal = []
  write(f, text => text.replace(`"requestedAt": ${start + 1000}`, `"requestedAt": ${start + 1000}.0005`))
  expect(collect().records[0].time).toMatchObject({ start: '2026-11-14T00:00:01.000000Z' })
})

test('rejects corrupt hashes, unsafe paths, duplicate IDs and invalid sample partitions', () => {
  write(fixture())
  writeFileSync(join(directory, 'manifest.sha256'), `${'0'.repeat(64)}  manifest.json\n`)
  expect(collect).toThrow('checksum')
  const f = fixture(); f.objects[0].bytes++
  write(f); expect(collect).toThrow('hash/size')
  f.objects[0].path = '../outside'
  write(f); expect(collect).toThrow('Unsafe')
  const duplicate = fixture(); duplicate.observations.push(capture('one'))
  write(duplicate); expect(collect).toThrow('duplicate')
  const partition = fixture()
  partition.journal[0].output.cards[0].details.push({ id: 'd2', text: 'Repeated', sampleIDs: ['one'] })
  write(partition); expect(collect).toThrow('partition')
  const notes = fixture(); notes.journal[0].output.frames = []
  write(notes); expect(collect).toThrow('frame notes')
  write(fixture())
  rmSync(join(directory, `objects/${hash}.mp4`))
  writeFileSync(join(root, 'outside'), movie)
  symlinkSync(join(root, 'outside'), join(directory, `objects/${hash}.mp4`))
  expect(collect).toThrow('escapes')
})

test('logical streams can change displays, but details cannot cross runs', () => {
  const f = fixture(), b = f.journal[0]
  f.observations.push(capture('two', start + 2000))
  b.sourceIDs.push('two')
  b.samples.push({ ...sample('two', start + 2000), displayID: 'other-display' })
  b.output.frames.push({ ...b.output.frames[0], sampleID: 'two' })
  b.output.cards[0].details[0].sampleIDs.push('two')
  write(f)
  const activity = collect().records.find(r => r.kind === 'daycap.journal.activity')!
  expect(activity.data).toMatchObject({ details: [{ stream_id: 'active', run_id: 'run' }] })
  const data = activity.data as Extract<DaycapPayload, { record_type: 'activity' }>
  expect(data.details![0].display_id).toBeUndefined()
  b.samples[1].runID = 'different'
  write(f); expect(collect).toThrow('streams/runs')
})

test('continuation pins only a matching predecessor generation, preserving unresolved context', () => {
  const f = fixture(), previous = batch('previous', start + 1000, 'one')
  const next = batch('next', start + 3000, 'two')
  next.context = [{ id: 'previous/c1', batchID: 'previous', title: 'Review', summary: 'Reviewed code', lastSampleAt: start + 1100 }]
  next.output.cards[0].continuationOf = 'previous/c1'
  f.observations.push(capture('two', start + 3000))
  f.journal = [previous, next]
  write(f)
  let result = collect()
  expect(result.records.find(r => r.id === 'journal/next/attempt/2/card/c1')!.data).toMatchObject({
    relations: expect.arrayContaining([{ relation: 'continues', target: {
      source: { type: 'daycap', instance: 'desktop' }, id: 'journal/previous/attempt/2/card/c1',
    } }]),
  })
  previous.output.cards[0].summary = 'Different generation'
  write(f); result = collect()
  expect(daycapReferences(result.evidenceBytes!, result.records, 'desktop')).toMatchObject({
    unresolved: [expect.objectContaining({ resolution: { status: 'unavailable', reason: 'generation-not-established' } })],
  })
})

test('half-open membership, gap markers, withdrawals, and reversed-bound diagnostics', () => {
  const f = fixture(); f.journal = []
  const c = capture('pause'); c.disposition = 'gap'; c.completedAt = c.requestedAt
  const reversed = capture('reversed'); reversed.completedAt = reversed.requestedAt - 1
  const end = capture('end', start + 86400000)
  f.observations = [c, reversed, end]
  f.withdrawals = [{ observationID: 'removed', previousRevision: 1, at: start + 5000, reason: 'manual' }]
  write(f)
  const result = collect()
  expect(result.records.map(r => r.kind)).toEqual(['daycap.gap', 'daycap.withdrawal'])
  expect(result.records[0].time).toMatchObject({ model: 'bounds', basis: 'recorded-gap' })
  expect(result.coverage.diagnostics).toEqual([{ pointer: '/observations/1', reason: 'reversed-wall-clock-bounds' }])
  expect(daycapReferences(result.evidenceBytes!, result.records, 'desktop')).toMatchObject({
    entries: [expect.objectContaining({ resolution: { status: 'unavailable', reason: 'withdrawn' } })],
  })
})

test('Evidence analyses and activities preserve explicit support and generation links', () => {
  const f = fixture(); f.journal = []
  f.analyses = [{
    id: 'analysis', status: 'complete', createdAt: start + 5000, model: 'model',
    observationIDs: ['one'], supportingObservationIDs: ['one'], summary: 'Summary',
    activities: [{ title: 'Read', detail: 'Read code', confidence: 'high', supportingObservationIDs: ['one'] }],
  }]
  write(f)
  expect(collect().records.map(r => r.kind)).toEqual(['daycap.capture', 'daycap.evidence.activity', 'daycap.evidence.analysis'])
})

test('DST day clipping retains source bounds and dependencies outside day membership', () => {
  const day = scope('2026-11-01', 'America/Chicago'), lo = Date.parse(day.start)
  expect(Date.parse(day.end) - lo).toBe(25 * 3600000)
  const f = fixture(); f.journal = []
  const before = capture('before', lo - 1000)
  const crossing = capture('crossing', lo - 50); crossing.completedAt = lo + 50
  const edge = capture('edge', Date.parse(day.end)); edge.completedAt = edge.requestedAt
  f.observations = [before, crossing, edge]
  f.analyses = [{
    id: 'across', status: 'complete', createdAt: lo + 100, model: 'fixture',
    observationIDs: ['before', 'crossing'], supportingObservationIDs: [], summary: 'Coverage',
  }]
  write(f)
  const result = daycap(day, directory, 'desktop', archive)
  const c = result.records.find(r => r.id === 'capture/crossing')!
  expect(c.time).toMatchObject({ start: '2026-11-01T04:59:59.950000Z' })
  expect(c.placement).toMatchObject({ start: day.start })
  expect(result.records.some(r => r.id === 'capture/before' || r.id === 'capture/edge')).toBe(false)
  expect(daycapReferences(result.evidenceBytes!, result.records, 'desktop')).toMatchObject({
    entries: expect.arrayContaining([expect.objectContaining({
      target: expect.objectContaining({ id: 'capture/before', revision: '2' }),
      resolution: { status: 'evidence-only', evidence: { file: 'evidence.json', pointer: '/observations/0' } },
    })]),
  })
})

test('metadata-only withdrawn captures omit normalized media and reject stale completed analyses', () => {
  const f = fixture(); f.observations[0].disposition = 'withdrawn'
  write(f); expect(collect).toThrow('withdrawn capture')
  f.journal = []
  write(f)
  const result = collect()
  expect(result.records[0].data).toMatchObject({ status: 'withdrawn' })
  expect(result.records[0].media).toBeUndefined()
  expect(result.records[0].text).toBeUndefined()
  result.records[0].evidence = { file: 'evidence.json', pointer: '/observations/99' }
  expect(() => daycapReferences(result.evidenceBytes!, result.records, 'desktop')).toThrow('unresolved evidence pointer')
})

test('reversed historical sample bounds retain evidence and diagnose omitted Journal projection', () => {
  const f = fixture(); f.journal[0].samples[0].completedAt = start
  const bytes = write(f), result = collect()
  expect(result.records.map(r => r.kind)).toEqual(['daycap.capture'])
  expect(result.evidenceBytes).toEqual(bytes)
  expect(result.coverage.diagnostics).toEqual([
    { pointer: '/journal/0', reason: 'reversed-sample-bounds; Journal projection omitted' },
  ])
})

test('repository and CLI inventory exact bytes and rebuild references during verification', () => {
  const bytes = write(fixture())
  const repo = new Repository(join(root, 'data')); repo.init()
  const result = collect()
  expect(repo.collect('daycap', 'desktop', bounds, result).changed).toBe(true)
  expect(repo.collect('daycap', 'desktop', bounds, collect()).changed).toBe(false)
  repo.verify(bounds.day)
  const prefix = '2026/11/14/daycap/desktop', path = join(repo.root, prefix)
  expect(readFileSync(join(path, 'evidence.json'))).toEqual(bytes)
  const cli = command([
    process.execPath, new URL('../src/cli.ts', import.meta.url).pathname, '--repo', repo.root, 'collect', 'daycap',
    '--day', bounds.day, '--timezone', 'UTC', '--instance', 'desktop',
    '--daycap-export', directory, '--media-archive', archive,
  ])
  expect(JSON.parse(cli.toString()).changed).toBe(false)
  // Rehash a false index: semantic verification still rejects it.
  const index = encode({ schema: 'vandelay.references/v1', entries: [], unresolved: [] })
  writeFileSync(join(path, 'references.json'), index)
  const manifest = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8'))
  manifest.files['references.json'] = { sha256: digest(index), bytes: index.length }
  const mb = encode(manifest); writeFileSync(join(path, 'manifest.json'), mb)
  const dayPath = join(repo.root, '2026/11/14.json')
  const day = JSON.parse(readFileSync(dayPath, 'utf8'))
  day.sources['daycap/desktop'] = { path: `${prefix}/manifest.json`, sha256: digest(mb), bytes: mb.length }
  writeFileSync(dayPath, encode(day))
  expect(() => repo.verify(bounds.day)).toThrow('reference index')
})
