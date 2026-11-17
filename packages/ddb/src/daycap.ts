import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { archiveMedia, archiveRoot, defaultMediaArchive } from './media-archive.ts'
import {
  compare, compareRecords, digest, expand, identifier, iso, json, record, safePath,
  Temporal, type ArchiveRecord, type Collected, type Media, type RecordInput,
  type RecordTime, type Scope,
} from './model.ts'

type ObjectValue = Record<string, unknown>
export interface RecordRef {
  source: { type: 'daycap'; instance: string }
  id: string
  revision?: string
}
interface EvidenceLocator { file: 'evidence.json'; pointer: string }
interface Dependency {
  target: RecordRef
  relation: 'supports' | 'input-to' | 'generated-by' | 'context-for' | 'continues' | 'withdraws' | 'output'
}
interface UnresolvedContext {
  source_reference: { batch_id: string; context_id: string }
  evidence: EvidenceLocator
}
interface PayloadBase {
  status: 'active' | 'withdrawn'
  relations: Dependency[]
}
interface CaptureMetadata {
  disposition: string
  session_id: string
  display_id: string
  stream_id?: string
  sequence: number
  monotonic: { clock: 'system-uptime'; session_id: string; requested_seconds: number; completed_seconds: number }
  target_interval_seconds?: number
  mode: string
  privacy: {
    policy_sha256: string
    ocr_retention: 'omitted' | 'retained'
    ocr_performed?: boolean
    filtering_enabled?: boolean
    evidence: EvidenceLocator[]
  }
  reason?: string
}
interface SubmissionMedia {
  role: 'capture' | 'submitted-input'
  availability: 'referenced' | 'not-retained'
  sha256: string
  selector?: Media['selector']
}
interface AnalysisInput {
  capture: RecordRef
  run_id: string
  archived_at_submission?: SubmissionMedia
  submitted_image?: SubmissionMedia
  evidence: EvidenceLocator
}
interface ActivityDetail {
  id: string
  text: string
  time: RecordTime
  supports: RecordRef[]
  stream_id: string
  run_id: string
  display_id?: string
}
interface AnalysisPayload extends PayloadBase {
  record_type: 'analysis'
  model: string
  created_at: string
  updated_at?: string
  analysis_status?: string
  batch_id?: string
  attempt?: number
  prompt_version?: string
  inputs?: AnalysisInput[]
  request_sha256?: string
  request_bytes?: number
  submission_policy_sha256?: string
  submission_ocr_filtering_enabled?: boolean
  analysis_privacy_checks_enabled?: boolean
  unresolved_context?: UnresolvedContext[]
  context?: EvidenceLocator[]
  provenance?: EvidenceLocator
}
/** Source-specific payloads evolve independently of the vandelay.record/v1 envelope. */
export type DaycapPayload =
  | (PayloadBase & { record_type: 'capture' | 'gap'; revision: string; capture: CaptureMetadata })
  | (PayloadBase & { record_type: 'gap'; reason: string; display_id: string; stream_id: string; derivation: string })
  | (PayloadBase & { record_type: 'observation'; app: string; confidence: string })
  | (PayloadBase & {
    record_type: 'activity'; confidence: string; category?: string; details?: ActivityDetail[]
    continuation_source?: string; unresolved_context?: UnresolvedContext[]
  })
  | (PayloadBase & { record_type: 'withdrawal'; reason: string })
  | AnalysisPayload
const locator = (pointer: string): EvidenceLocator => ({ file: 'evidence.json', pointer })
function object(v: unknown): ObjectValue {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Daycap: expected object')
  return v as ObjectValue
}
function list(v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new Error('Daycap: expected array')
  return v
}
function text(v: unknown): string {
  if (typeof v !== 'string') throw new Error('Daycap: expected string')
  return v
}
function id(v: unknown): string {
  const s = text(v)
  if (!s || s.includes('/')) throw new Error('Daycap: invalid local ID')
  return s
}
function integer(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
    throw new Error('Daycap: expected nonnegative safe integer')
  return v
}
function finite(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('Daycap: expected finite number')
  return v
}
function boolean(v: unknown): boolean {
  if (typeof v !== 'boolean') throw new Error('Daycap: expected boolean')
  return v
}
function unique<T>(items: T[], key: (v: T) => string): Map<string, T> {
  const result = new Map<string, T>()
  for (const item of items) {
    const k = key(item)
    if (result.has(k)) throw new Error(`Daycap: duplicate identity ${k}`)
    result.set(k, item)
  }
  return result
}

/** Decimal Unix milliseconds -> microseconds, nearest with ties to even. */
export function milliseconds(value: unknown): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text(value))
  if (!match) throw new Error('Daycap: invalid Unix milliseconds')
  const fraction = match[3] ?? ''
  const exponent = Number(match[4] ?? 0) - fraction.length + 3
  if (Math.abs(exponent) > 100) throw new Error('Daycap: timestamp out of range')
  let n = BigInt(match[2] + fraction)
  if (exponent >= 0) n *= 10n ** BigInt(exponent)
  else {
    const divisor = 10n ** BigInt(-exponent), remainder = n % divisor
    n /= divisor
    if (remainder * 2n > divisor || (remainder * 2n === divisor && n % 2n !== 0n)) n++
  }
  if (match[1]) n = -n
  return iso(Temporal.Instant.fromEpochNanoseconds(n * 1000n))
}
const dateKeys = new Set([
  'from', 'to', 'start', 'end', 'requestedAt', 'completedAt', 'persistedAt',
  'createdAt', 'updatedAt', 'at', 'lastSampleAt', 'evidenceStart', 'evidenceEnd', 'privacyAcceptedAt',
])
/** Bun exposes the original numeric token via the JSON reviver context. */
function parse(bytes: Buffer): ObjectValue {
  return object(JSON.parse(bytes.toString('utf8'), (key: string, value: unknown, context?: { source?: string }) => {
    if (dateKeys.has(key) && typeof value === 'number') {
      if (!context?.source) throw new Error('Daycap requires JSON.parse source context')
      return context.source
    }
    if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))))
      throw new Error('Daycap: unsafe source number')
    return value
  }))
}
function bounds(start: unknown, end: unknown, basis: string): RecordTime {
  return { model: 'bounds', start: milliseconds(start), end: milliseconds(end), basis }
}
function envelope(items: ObjectValue[]): RecordTime {
  if (!items.length) throw new Error('Daycap: empty sample envelope')
  const starts = items.map(s => milliseconds(s.requestedAt)).sort(compare)
  const ends = items.map(s => milliseconds(s.completedAt)).sort(compare)
  return { model: 'bounds', start: starts[0], end: ends[ends.length - 1], basis: 'sample-envelope' }
}
function selector(video: unknown): NonNullable<Media['selector']> {
  const v = object(video)
  identifier(text(v.segmentHash))
  const duration = integer(v.durationMicroseconds)
  if (duration === 0) throw new Error('Daycap: expected positive sample duration')
  return {
    type: 'video-frame', frame_index: integer(v.frameIndex),
    presentation: { value: String(integer(v.presentationMicroseconds)), timescale: 1_000_000 },
    duration: { value: String(duration), timescale: 1_000_000 },
  }
}
function captureID(o: ObjectValue): string {
  return `${o.disposition === 'gap' ? 'gap' : 'capture'}/${id(o.id)}`
}
function batchID(b: ObjectValue): string {
  return `journal/${id(b.id)}/attempt/${integer(b.attempts)}`
}
function withdrawalID(w: ObjectValue): string {
  // The producer does not export the withdrawal table's UUID.
  return `withdrawal/${digest(json(w))}`
}

export function daycap(
  scope: Scope, directory: string, instance: string, mediaDirectory = defaultMediaArchive,
): Collected {
  const root = expand(directory)
  const bytes = readFileSync(join(root, 'manifest.json'))
  const checksum = readFileSync(join(root, 'manifest.sha256'), 'utf8')
  if (!/^[a-f0-9]{64}  manifest\.json\n?$/.test(checksum) || checksum.slice(0, 64) !== digest(bytes))
    throw new Error('Daycap: manifest checksum mismatch')
  const source = parse(bytes)
  if (source.schema !== 'daycap.export/v3') throw new Error('Unsupported Daycap export schema')
  id(source.id); text(source.timezone)
  Temporal.Now.instant().toZonedDateTimeISO(text(source.timezone))
  const from = milliseconds(source.from), to = milliseconds(source.to)
  if (from >= to) throw new Error('Daycap: invalid export scope')
  const captures = list(source.observations).map(object)
  const journal = list(source.journal ?? []).map(object)
  const analyses = list(source.analyses).map(object)
  const withdrawals = list(source.withdrawals).map(object)
  const byCapture = unique(captures, c => id(c.id))
  unique(journal, b => id(b.id)); unique(analyses, a => id(a.id))
  const archived = new Map<string, Media>()
  const objects = list(source.objects).map(object)
  unique(objects, o => text(o.path)); unique(objects, o => identifier(text(o.sha256)))
  const archive = archiveRoot(mediaDirectory, root)
  for (const o of objects) {
    const hash = identifier(text(o.sha256)), size = integer(o.bytes)
    const media = archiveMedia(safePath(root, text(o.path)), archive)
    if (media.sha256 !== hash || media.bytes !== size)
      throw new Error(`Daycap: object hash/size mismatch: ${text(o.path)}`)
    archived.set(hash, { ...media, role: 'capture' })
  }
  const records: ArchiveRecord[] = [], diagnostics: { pointer: string; reason: string }[] = []
  const ref = (identity: string, revision?: unknown): RecordRef => ({
    source: { type: 'daycap', instance }, id: identity,
    ...(revision === undefined ? {} : { revision: String(integer(revision)) }),
  })
  const captureRef = (identity: string): RecordRef => {
    const c = byCapture.get(identity)
    return c ? ref(captureID(c), c.revision) : ref(`capture/${identity}`)
  }
  const add = (input: RecordInput, pointer: string) => {
    const time = input.time
    if ((time.model === 'bounds' || time.model === 'interval') && time.start > time.end) {
      diagnostics.push({ pointer, reason: 'reversed-wall-clock-bounds' })
      return
    }
    const item = record({ ...input, evidence: { ...locator(pointer) } }, scope)
    if (item) records.push(item)
  }
  const dependencies = (targets: RecordRef[], relation: Dependency['relation']): Dependency[] =>
    targets.map(target => ({ relation, target }))
  for (const [i, c] of captures.entries()) {
    const disposition = text(c.disposition), revision = String(integer(c.revision))
    if (!['captured', 'blocked', 'pending', 'quarantined', 'withdrawn', 'gap'].includes(disposition))
      throw new Error('Daycap: unknown capture disposition')
    const time = bounds(c.requestedAt, c.completedAt, disposition === 'gap' ? 'recorded-gap' : 'capture-request-completion')
    const media: Media[] = []
    if (disposition === 'captured') {
      const hash = c.video ? text(object(c.video).segmentHash) : text(c.imageHash)
      const current = archived.get(identifier(hash))
      if (!current) throw new Error('Daycap: captured media absent from object inventory')
      media.push({ ...current, ...(c.video ? { selector: selector(c.video) } : {}) })
    }
    const data: DaycapPayload = {
      record_type: disposition === 'gap' ? 'gap' : 'capture', revision,
      status: disposition === 'withdrawn' ? 'withdrawn' : 'active', relations: [],
      capture: {
        disposition, session_id: text(c.sessionID), display_id: text(object(c.display).id),
        ...(c.streamID === undefined ? {} : { stream_id: text(c.streamID) }),
        sequence: integer(c.sequence),
        monotonic: {
          clock: 'system-uptime', session_id: text(c.sessionID),
          requested_seconds: finite(c.requestedMonotonic), completed_seconds: finite(c.completedMonotonic),
        },
        ...(c.samplingTargetSeconds == null ? {} : { target_interval_seconds: finite(c.samplingTargetSeconds) }),
        mode: text(c.captureMode ?? 'evidence'),
        privacy: {
          policy_sha256: identifier(text(c.policyHash)),
          ocr_retention: c.captureMode === 'journal' ? 'omitted' : 'retained',
          ...(c.ocrPerformed === undefined ? {} : { ocr_performed: boolean(c.ocrPerformed) }),
          ...(c.privacyFiltered === undefined ? {} : { filtering_enabled: boolean(c.privacyFiltered) }),
          evidence: [locator(`/observations/${i}`)],
        },
        ...(c.reason === undefined ? {} : { reason: text(c.reason) }),
      },
    }
    add({ id: captureID(c), kind: `daycap.${data.record_type}`, time, data, ...(media.length ? { media } : {}) }, `/observations/${i}`)
  }

  for (const [bi, b] of journal.entries()) {
    const pointer = `/journal/${bi}`, identity = batchID(b)
    if (b.status !== 'complete') throw new Error('Daycap v3: expected completed Journal batch')
    const samples = list(b.samples).map(object), bySample = unique(samples, s => id(s.id))
    const assigned = list(b.sourceIDs).map(id)
    unique(assigned, s => s)
    if (assigned.some(s => !byCapture.has(s)))
      throw new Error('Daycap: assigned capture not exported')
    if (assigned.some(s => byCapture.get(s)!.disposition === 'withdrawn'))
      throw new Error('Daycap: completed Journal depends on withdrawn capture')
    let reversedSample = false
    for (const s of samples) {
      if (!assigned.includes(id(s.id)) || !byCapture.has(id(s.id)))
        throw new Error('Daycap: sample missing from assigned captures')
      integer(s.revision); text(s.displayID); text(s.runID)
      const t = bounds(s.requestedAt, s.completedAt, 'capture-request-completion')
      if (t.model === 'bounds' && t.start > t.end)
        reversedSample = true
    }
    if (reversedSample) {
      diagnostics.push({ pointer, reason: 'reversed-sample-bounds; Journal projection omitted' })
      continue
    }
    const sampleRefs = (ss: ObjectValue[]) => ss.map(s => ref(`capture/${id(s.id)}`, s.revision))
    const select = (value: unknown): ObjectValue[] => {
      const ids = list(value).map(id)
      unique(ids, s => s)
      if (!ids.length) throw new Error('Daycap: empty support list')
      return ids.map(s => {
        const sample = bySample.get(s)
        if (!sample) throw new Error('Daycap: unknown sample support')
        return sample
      })
    }
    const output = object(b.output), frames = list(output.frames).map(object), cards = list(output.cards).map(object)
    unique(cards, c => id(c.id))
    if (json(frames.map(f => id(f.sampleID))) !== json(samples.map(s => id(s.id))))
      throw new Error('Daycap: frame notes must cover selected samples once in order')
    const contexts = list(b.context).map(object)
    unique(contexts, c => text(c.id))
    const unresolved: UnresolvedContext[] = []
    const contextRefs = new Map<string, RecordRef>()
    for (const [ci, context] of contexts.entries()) {
      const previous = journal.find(p => p.id === context.batchID)
      const candidates = previous ? list(object(previous.output).cards).map(object) : []
      const card = candidates.find(c => `${text(context.batchID)}/${id(c.id)}` === context.id &&
        c.title === context.title && [...text(c.summary)].slice(0, 1200).join('') === context.summary)
      // Match the supplied snapshot and last sample time, never guess an attempt.
      let matches = false
      if (previous && card) {
        const ids = list(card.details).flatMap(d => list(object(d).sampleIDs).map(id))
        const ss = list(previous.samples).map(object).filter(s => ids.includes(id(s.id)))
        const latest = ss.map(s => milliseconds(s.completedAt)).sort(compare).at(-1)
        matches = latest === milliseconds(context.lastSampleAt) &&
          milliseconds(previous.start) < milliseconds(b.start)
      }
      if (previous && card && matches) contextRefs.set(text(context.id), ref(`${batchID(previous)}/card/${id(card.id)}`))
      else unresolved.push({
        source_reference: { batch_id: id(context.batchID), context_id: text(context.id) },
        evidence: locator(`${pointer}/context/${ci}`),
      })
    }
    const outputs: RecordRef[] = []
    for (const [fi, f] of frames.entries()) {
      const s = samples[fi], nid = `${identity}/note/${id(s.id)}`
      outputs.push(ref(nid))
      add({
        id: nid, kind: 'daycap.journal.observation', time: envelope([s]), text: text(f.note),
        interpretation: 'source-generated',
        data: {
          record_type: 'observation', status: 'active', app: text(f.app), confidence: text(f.confidence),
          relations: [...dependencies(sampleRefs([s]), 'supports'), ...dependencies([ref(identity)], 'generated-by')],
        } satisfies DaycapPayload,
      }, `${pointer}/output/frames/${fi}`)
    }
    const covered: string[] = []
    let previousCardStart = ''
    for (const [ci, c] of cards.entries()) {
      const details = list(c.details).map(object)
      unique(details, d => id(d.id))
      if (!details.length) throw new Error('Daycap: card has no details')
      let previousDetailStart = ''
      const normalized = details.map(d => {
        const ss = select(d.sampleIDs), times = ss.map(s => milliseconds(s.requestedAt))
        if (new Set(ss.map(s => `${text(s.streamID ?? s.displayID)}\0${text(s.runID)}`)).size !== 1 ||
          json(times) !== json([...times].sort(compare)) || times[0] < previousDetailStart)
          throw new Error('Daycap: detail crosses streams/runs or is not chronological')
        previousDetailStart = times[0]
        covered.push(...ss.map(s => id(s.id)))
        return {
          id: id(d.id), text: text(d.text), time: envelope(ss), supports: sampleRefs(ss),
          stream_id: text(ss[0].streamID ?? ss[0].displayID), run_id: text(ss[0].runID),
          ...(new Set(ss.map(s => s.displayID)).size === 1 ? { display_id: text(ss[0].displayID) } : {}),
        }
      })
      const ss = details.flatMap(d => select(d.sampleIDs)), time = envelope(ss)
      if (time.model !== 'bounds') throw new Error('Daycap: expected sample bounds')
      if (time.start < previousCardStart) throw new Error('Daycap: cards not chronological')
      previousCardStart = time.start
      const cid = `${identity}/card/${id(c.id)}`
      const relations = [...dependencies(sampleRefs(ss), 'supports'), ...dependencies([ref(identity)], 'generated-by')]
      if (c.continuationOf != null) {
        const context = contexts.find(ctx => ctx.id === c.continuationOf)
        if (!context || milliseconds(context.lastSampleAt) > time.start)
          throw new Error('Daycap: invalid continuation')
        const target = contextRefs.get(text(c.continuationOf))
        if (target) relations.push({ relation: 'continues', target })
      }
      outputs.push(ref(cid))
      add({
        id: cid, kind: 'daycap.journal.activity', time, title: text(c.title), text: text(c.summary),
        interpretation: 'source-generated',
        data: {
          record_type: 'activity', status: 'active', category: text(c.category),
          confidence: text(c.confidence), details: normalized, relations,
          ...(c.continuationOf == null ? {} : { continuation_source: text(c.continuationOf) }),
          unresolved_context: unresolved,
        } satisfies DaycapPayload,
      }, `${pointer}/output/cards/${ci}`)
    }
    if (covered.length !== samples.length || new Set(covered).size !== samples.length)
      throw new Error('Daycap: card details must partition selected samples exactly once')
    const inputs = samples.map<AnalysisInput>((s, si) => {
      const hash = s.video ? text(object(s.video).segmentHash) : s.imageHash
      return {
        capture: sampleRefs([s])[0], run_id: text(s.runID),
        ...(hash == null ? {} : {
          archived_at_submission: {
            role: 'capture', availability: 'referenced', sha256: identifier(text(hash)),
            ...(s.video ? { selector: selector(s.video) } : {}),
          },
        }),
        ...(s.submittedPNGHash == null ? {} : {
          submitted_image: { role: 'submitted-input', availability: 'not-retained', sha256: identifier(text(s.submittedPNGHash)) },
        }),
        evidence: locator(`${pointer}/samples/${si}`),
      }
    })
    add({
      id: identity, kind: 'daycap.journal.analysis', time: bounds(b.start, b.end, 'input-coverage'),
      interpretation: 'source-generated',
      data: {
        record_type: 'analysis', status: 'active', analysis_status: text(b.status),
        batch_id: id(b.id), attempt: integer(b.attempts), model: text(b.model),
        prompt_version: text(b.promptVersion), inputs,
        created_at: milliseconds(b.createdAt), updated_at: milliseconds(b.updatedAt),
        ...(b.requestHash == null ? {} : { request_sha256: identifier(text(b.requestHash)) }),
        ...(b.requestBytes == null ? {} : { request_bytes: integer(b.requestBytes) }),
        ...(b.submissionPolicyHash == null ? {} : { submission_policy_sha256: identifier(text(b.submissionPolicyHash)) }),
        ...(b.submissionOCRFilteringEnabled == null ? {} : { submission_ocr_filtering_enabled: boolean(b.submissionOCRFilteringEnabled) }),
        ...(b.analysisPrivacyChecksEnabled == null ? {} : { analysis_privacy_checks_enabled: boolean(b.analysisPrivacyChecksEnabled) }),
        relations: [
          ...dependencies(assigned.map(captureRef), 'input-to'),
          ...dependencies([...contextRefs.values()], 'context-for'),
          ...dependencies(outputs, 'output'),
        ],
        unresolved_context: unresolved,
        context: contexts.map((_, ci) => locator(`${pointer}/context/${ci}`)),
        provenance: locator(pointer),
      } satisfies DaycapPayload,
    }, pointer)
    for (const [gi, g] of list(b.gaps).map(object).entries()) {
      add({
        id: `journal/${id(b.id)}/gap/${gi}`, kind: 'daycap.gap',
        time: bounds(g.start, g.end, 'between-capture-gap'), interpretation: 'adapter-derived',
        data: {
          record_type: 'gap', status: 'active', relations: [],
          reason: text(g.reason), display_id: text(g.displayID),
          stream_id: text(g.streamID ?? g.displayID),
          derivation: 'Producer Journal capture-discontinuity algorithm; bounds retained verbatim.',
        } satisfies DaycapPayload,
      }, `${pointer}/gaps/${gi}`)
    }
  }
  for (const [ai, a] of analyses.entries()) {
    const identity = `analysis/${id(a.id)}`, pointer = `/analyses/${ai}`
    if (a.status !== 'complete') throw new Error('Daycap v3: expected completed Evidence analysis')
    const ids = list(a.observationIDs).map(id)
    const inputs = ids.map(i => {
      const c = byCapture.get(i)
      if (!c) throw new Error('Daycap: analysis input not exported')
      if (c.disposition === 'withdrawn') throw new Error('Daycap: completed analysis depends on withdrawn capture')
      return c
    })
    const time = a.evidenceStart != null && a.evidenceEnd != null
      ? bounds(a.evidenceStart, a.evidenceEnd, 'input-coverage') : envelope(inputs)
    add({
      id: identity, kind: 'daycap.evidence.analysis', time, text: text(a.summary),
      interpretation: 'source-generated',
      data: {
        record_type: 'analysis', status: 'active', model: text(a.model),
        created_at: milliseconds(a.createdAt),
        ...(a.analysisPrivacyChecksEnabled == null ? {} : { analysis_privacy_checks_enabled: boolean(a.analysisPrivacyChecksEnabled) }),
        relations: [
          ...dependencies(ids.map(captureRef), 'input-to'),
          ...dependencies(list(a.supportingObservationIDs ?? []).map(id).map(captureRef), 'supports'),
        ],
      } satisfies DaycapPayload,
    }, pointer)
    for (const [oi, activity] of list(a.activities ?? []).map(object).entries()) {
      const supports = list(activity.supportingObservationIDs).map(id)
      const cs = supports.map(s => {
        const c = byCapture.get(s)
        if (!c || !ids.includes(s)) throw new Error('Daycap: invalid Evidence activity support')
        return c
      })
      add({
        id: `${identity}/activity/${oi}`, kind: 'daycap.evidence.activity',
        time: cs.length ? envelope(cs) : time, title: text(activity.title), text: text(activity.detail),
        interpretation: 'source-generated',
        data: {
          record_type: 'activity', status: 'active', confidence: text(activity.confidence),
          relations: [...dependencies(supports.map(captureRef), 'supports'), ...dependencies([ref(identity)], 'generated-by')],
        } satisfies DaycapPayload,
      }, `${pointer}/activities/${oi}`)
    }
  }
  for (const [wi, w] of withdrawals.entries()) {
    add({
      id: withdrawalID(w), kind: 'daycap.withdrawal',
      time: { model: 'instant', at: milliseconds(w.at), basis: 'withdrawal-event' },
      data: {
        record_type: 'withdrawal', status: 'active', reason: text(w.reason),
        relations: dependencies([ref(`capture/${id(w.observationID)}`, w.previousRevision)], 'withdraws'),
      } satisfies DaycapPayload,
    }, `/withdrawals/${wi}`)
  }
  unique(records, r => r.id)
  records.sort(compareRecords)
  return {
    records, evidence: JSON.parse(bytes.toString()), evidenceBytes: bytes,
    coverage: {
      state: 'observed', method: 'verified-daycap-v3-export', export_id: text(source.id),
      source_schema: source.schema, manifest_sha256: digest(bytes),
      source_scope: { start: from, end: to, timezone: text(source.timezone) },
      diagnostics,
      limitations: [
        'Captures selected by request time; export is not arbitrary overlap closure.',
        'Video sample durations describe source media ranges, not continuous screen coverage.',
        'Journal batches require an in-range start and all assigned captures selected; only completed analyses are exported.',
        'Retries retain only the current known attempt; context may refer to unexported generations.',
        'Export re-encoding may change capture revisions/media; historical submission bytes are not retained.',
        'Withdrawal dependencies and lifecycle history may be absent; missing records do not establish inactivity or withdrawal.',
        'Withdrawal IDs are derived from exported event content because source event UUIDs are not exported.',
      ],
    },
  }
}

/** A pure index: no filesystem, live-store queries, or neighboring-bundle lookup. */
export function daycapReferences(evidenceBytes: Buffer, records: ArchiveRecord[], instance: string): unknown {
  const source = parse(evidenceBytes)
  if (source.schema !== 'daycap.export/v3') throw new Error('Unsupported Daycap export schema')
  const namespace = { type: 'daycap' as const, instance }
  const checkLocators = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { value.forEach(checkLocators); return }
    const o = object(value)
    if (o.file === 'evidence.json') {
      const pointer = text(o.pointer)
      if (pointer !== '' && !pointer.startsWith('/')) throw new Error('Daycap: invalid evidence pointer')
      let current: unknown = source
      for (const token of pointer === '' ? [] : pointer.slice(1).split('/')) {
        if (/~(?![01])/.test(token)) throw new Error('Daycap: invalid pointer escape')
        const key = token.replaceAll('~1', '/').replaceAll('~0', '~')
        if (!current || typeof current !== 'object' || !Object.hasOwn(current, key))
          throw new Error(`Daycap: unresolved evidence pointer ${pointer}`)
        current = (current as ObjectValue)[key]
      }
    }
    Object.values(o).forEach(checkLocators)
  }
  records.forEach(checkLocators)
  const evidence = new Map<string, EvidenceLocator>()
  const key = (target: RecordRef) => json(target)
  const remember = (identity: string, pointer: string, revision?: unknown) => {
    const target: RecordRef = { source: namespace, id: identity, ...(revision === undefined ? {} : { revision: String(integer(revision)) }) }
    if (!evidence.has(key(target))) evidence.set(key(target), locator(pointer))
  }
  list(source.observations).map(object).forEach((c, i) => remember(captureID(c), `/observations/${i}`, c.revision))
  list(source.journal ?? []).map(object).forEach((b, i) => {
    const base = batchID(b), pointer = `/journal/${i}`
    remember(base, pointer)
    list(b.samples).map(object).forEach((s, si) => remember(`capture/${id(s.id)}`, `${pointer}/samples/${si}`, s.revision))
    const output = object(b.output)
    list(output.frames).map(object).forEach((f, fi) => remember(`${base}/note/${id(f.sampleID)}`, `${pointer}/output/frames/${fi}`))
    list(output.cards).map(object).forEach((c, ci) => remember(`${base}/card/${id(c.id)}`, `${pointer}/output/cards/${ci}`))
    list(b.gaps).forEach((_, gi) => remember(`journal/${id(b.id)}/gap/${gi}`, `${pointer}/gaps/${gi}`))
  })
  list(source.analyses).map(object).forEach((a, i) => {
    remember(`analysis/${id(a.id)}`, `/analyses/${i}`)
    list(a.activities ?? []).forEach((_, ai) => remember(`analysis/${id(a.id)}/activity/${ai}`, `/analyses/${i}/activities/${ai}`))
  })
  list(source.withdrawals).map(object).forEach((w, i) => remember(withdrawalID(w), `/withdrawals/${i}`))
  const included = new Set(records.map(r => {
    const d = object(r.data)
    return key({ source: namespace, id: r.id, ...(d.revision === undefined ? {} : { revision: text(d.revision) }) })
  }))
  const targets = new Map<string, RecordRef>(), unresolved = new Map<string, UnresolvedContext>()
  const addTarget = (value: unknown) => {
    const target = object(value) as unknown as RecordRef
    if (json(target.source) !== json(namespace) || typeof target.id !== 'string' || !target.id ||
      (target.revision !== undefined && typeof target.revision !== 'string'))
      throw new Error('Daycap: invalid record reference')
    targets.set(key(target), target)
  }
  // Traverse only typed reference positions, never arbitrary source prose/extension fields.
  for (const r of records) {
    const d = object(r.data)
    for (const rel of list(d.relations).map(object)) {
      addTarget(rel.target)
    }
    for (const input of list(d.inputs ?? []).map(object)) {
      addTarget(input.capture)
    }
    for (const detail of list(d.details ?? []).map(object))
      list(detail.supports).forEach(addTarget)
    for (const ctx of list(d.unresolved_context ?? [])) {
      const item = object(ctx) as unknown as UnresolvedContext
      unresolved.set(json(item), item)
    }
  }
  const withdrawn = new Set(list(source.withdrawals).map(object).map(w =>
    key({ source: namespace, id: `capture/${id(w.observationID)}`, revision: String(integer(w.previousRevision)) })))
  const entries = [...targets.entries()].sort(([a], [b]) => compare(a, b)).map(([k, target]) => ({
    target,
    resolution: included.has(k)
      ? { status: 'included', file: 'records.jsonl' }
      : evidence.has(k)
        ? { status: 'evidence-only', evidence: evidence.get(k)! }
        : { status: 'unavailable', reason: withdrawn.has(k) ? 'withdrawn' : 'unknown' },
  }))
  return {
    schema: 'vandelay.references/v1', entries,
    unresolved: [...unresolved.entries()].sort(([a], [b]) => compare(a, b)).map(([, item]) => ({
      ...item, resolution: { status: 'unavailable', reason: 'generation-not-established' },
    })),
  }
}
