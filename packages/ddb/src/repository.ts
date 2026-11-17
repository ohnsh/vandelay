import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite, command, withLock } from './io.ts'
import { daycapReferences } from './daycap.ts'
import {
  digest,
  encode,
  equal,
  expand,
  safePath,
  scope,
  validateRecord,
  type Collected,
  type Manifest,
  type Scope,
  type Source,
} from './model.ts'

interface FileRef {
  path: string
  sha256: string
  bytes: number
}
export interface Day {
  schema: 'vandelay.day/v1'
  scope: Scope
  sources: Record<string, FileRef>
}
export type TimestampAction = 'stamp' | 'upgrade' | 'verify' | 'info'

export function dayPath(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Day must be YYYY-MM-DD')
  scope(day, 'UTC')
  return day.replaceAll('-', '/') + '.json'
}
function instanceName(instance: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(instance))
    throw new Error(
      'Instance must start with a letter/digit and contain only letters, digits, dots, underscores or hyphens',
    )
  return instance
}
const reference = (path: string, bytes: Buffer): FileRef => ({
  path,
  sha256: digest(bytes),
  bytes: bytes.length,
})

export class Repository {
  readonly root: string
  constructor(root = 'data') {
    this.root = expand(root)
  }
  git(...args: string[]): Buffer {
    return command(['git', '--no-replace-objects', '-C', this.root, ...args])
  }
  assertRepository(): string {
    const top = this.git('rev-parse', '--show-toplevel').toString().trim()
    if (realpathSync(top) !== realpathSync(this.root))
      throw new Error('--repo must be the data repository root')
    return this.git('rev-parse', '--absolute-git-dir').toString().trim()
  }
  init(format: 'sha1' | 'sha256' = 'sha256'): void {
    mkdirSync(this.root, { recursive: true })
    this.git('init', '--initial-branch=main', `--object-format=${format}`)
    this.assertRepository()
    // Preserve exact manifest/payload bytes in blobs, independently of platform.
    const attributes = join(this.root, '.gitattributes')
    if (!existsSync(attributes)) atomicWrite(attributes, Buffer.from('* -text -filter\n'))
  }
  collect(
    source: Source,
    instance: string,
    bounds: Scope,
    collected: Collected,
  ): { day: string; source: string; changed: boolean } {
    instanceName(instance)
    if (!['activitywatch', 'dayflow', 'daycap', 'vod'].includes(source))
      throw new Error('Unknown source')
    if (!equal(bounds, scope(bounds.day, bounds.timezone)))
      throw new Error('Invalid day scope')
    const ids = new Set<string>()
    for (const item of collected.records) {
      validateRecord(item, bounds)
      if (ids.has(item.id)) throw new Error('Duplicate record ID')
      ids.add(item.id)
    }
    const gitDir = this.assertRepository()
    return withLock(gitDir, () => {
      const path = dayPath(bounds.day),
        full = safePath(this.root, path)
      const day: Day = existsSync(full)
        ? this.verify(bounds.day)
        : { schema: 'vandelay.day/v1', scope: bounds, sources: {} }
      if (!equal(day.scope, bounds))
        throw new Error(
          'A date has one timezone per repository; use another repository for a different scope',
        )
      const slot = `${source}/${instance}`,
        prefix = `${path.slice(0, -5)}/${slot}`
      const evidenceBytes = collected.evidenceBytes ?? encode(collected.evidence)
      JSON.parse(evidenceBytes.toString())
      const payloads: Record<string, Buffer> = {
        'evidence.json': evidenceBytes,
        'records.jsonl': Buffer.concat(collected.records.map(encode)),
      }
      if (source === 'daycap')
        payloads['references.json'] = encode(daycapReferences(evidenceBytes, collected.records, instance))
      const manifest: Manifest = {
        schema: 'vandelay.bundle/v1',
        record_schema: 'vandelay.record/v1',
        scope: bounds,
        source: { type: source, instance },
        producer: { name: '@vandelay/ddb', version: '0.1.0', adapter: `${source}/${source === 'daycap' ? 3 : 2}` },
        coverage: collected.coverage,
        record_count: collected.records.length,
        files: Object.fromEntries(
          Object.entries(payloads).map(([name, bytes]) => [
            name,
            { sha256: digest(bytes), bytes: bytes.length },
          ]),
        ),
      }
      const manifestBytes = encode(manifest),
        ref = reference(`${prefix}/manifest.json`, manifestBytes)
      if (equal(day.sources[slot] ?? null, ref))
        return { day: path, source: slot, changed: false }
      // Publish the day manifest last. Git provides the atomic, durable snapshot at commit time.
      for (const [name, bytes] of Object.entries(payloads))
        atomicWrite(safePath(this.root, `${prefix}/${name}`), bytes)
      atomicWrite(safePath(this.root, ref.path), manifestBytes)
      day.sources[slot] = ref
      atomicWrite(full, encode(day))
      return { day: path, source: slot, changed: true }
    })
  }
  resolveCommit(revision: string): string {
    return this.git('rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`)
      .toString()
      .trim()
  }
  verify(date: string, revision?: string): Day {
    this.assertRepository()
    const commit = revision === undefined ? undefined : this.resolveCommit(revision)
    const read = (path: string): Buffer => {
      safePath(this.root, path)
      return commit
        ? this.git('cat-file', 'blob', `${commit}:${path}`)
        : readFileSync(safePath(this.root, path))
    }
    const checked = (ref: FileRef): Buffer => {
      const bytes = read(ref.path)
      if (bytes.length !== ref.bytes || digest(bytes) !== ref.sha256)
        throw new Error(`Hash/size mismatch: ${ref.path}`)
      return bytes
    }
    const path = dayPath(date),
      day: Day = JSON.parse(read(path).toString())
    if (
      day.schema !== 'vandelay.day/v1' ||
      day.scope.day !== date ||
      !equal(day.scope, scope(date, day.scope.timezone)) ||
      !day.sources ||
      Array.isArray(day.sources)
    )
      throw new Error('Invalid day manifest')
    for (const [slot, ref] of Object.entries(day.sources)) {
      const [source, instance, extra] = slot.split('/')
      if (extra !== undefined || !['activitywatch', 'dayflow', 'daycap', 'vod'].includes(source))
        throw new Error('Invalid source slot')
      instanceName(instance)
      const prefix = `${path.slice(0, -5)}/${slot}`
      if (ref.path !== `${prefix}/manifest.json`)
        throw new Error('Unexpected source manifest path')
      const manifest: Manifest = JSON.parse(checked(ref).toString())
      if (
        manifest.schema !== 'vandelay.bundle/v1' ||
        manifest.record_schema !== 'vandelay.record/v1' ||
        !equal(manifest.scope, day.scope) ||
        manifest.source.type !== source ||
        manifest.source.instance !== instance
      )
        throw new Error('Invalid source manifest')
      const inventory = source === 'daycap'
        ? ['evidence.json', 'records.jsonl', 'references.json']
        : ['evidence.json', 'records.jsonl']
      if (!equal(Object.keys(manifest.files).sort(), inventory))
        throw new Error('Invalid payload inventory')
      const payloads: Record<string, Buffer> = {}
      for (const [name, entry] of Object.entries(manifest.files)) {
        const bytes = checked({ ...entry, path: `${prefix}/${name}` })
        payloads[name] = bytes
        if (name !== 'records.jsonl') JSON.parse(bytes.toString())
        else {
          const text = bytes.toString()
          if (text && !text.endsWith('\n')) throw new Error('JSONL must end with LF')
          const records = text
            ? text
                .slice(0, -1)
                .split('\n')
                .map((line) => JSON.parse(line))
            : []
          if (records.length !== manifest.record_count)
            throw new Error('Record count mismatch')
          const ids = new Set<string>()
          for (const item of records) {
            validateRecord(item, manifest.scope)
            if (ids.has(item.id)) throw new Error('Duplicate record ID')
            ids.add(item.id)
          }
        }
      }
      if (source === 'daycap') {
        const text = payloads['records.jsonl'].toString()
        const records = text ? text.trimEnd().split('\n').map(line => JSON.parse(line)) : []
        const expected = encode(daycapReferences(payloads['evidence.json'], records, instance))
        if (!expected.equals(payloads['references.json']))
          throw new Error('Daycap reference index does not match evidence and records')
      }
    }
    return day
  }
  timestamp(
    action: TimestampAction,
    revision = 'HEAD',
    run: (args: string[]) => void = (args) => {
      command(args, { stdio: ['inherit', 2, 2] })
    },
  ): { commit: string; proof: string; state: string } {
    const gitDir = this.assertRepository(),
      commit = this.resolveCommit(revision)
    // Git applies the caller's configured trust policy (e.g. SSH allowedSignersFile).
    this.git('verify-commit', commit)
    const bytes = this.git('cat-file', 'commit', commit)
    return withLock(gitDir, () => {
      const relative = `proofs/${commit}/commit`,
        path = safePath(this.root, relative),
        proof = safePath(this.root, relative + '.ots')
      if (existsSync(path)) {
        if (!readFileSync(path).equals(bytes))
          throw new Error('Stored timestamp subject differs from Git commit')
      } else {
        if (action !== 'stamp')
          throw new Error('No timestamp subject; run timestamp stamp first')
        atomicWrite(path, bytes)
      }
      if (action === 'stamp') {
        if (!existsSync(proof)) run(['ots', 'stamp', path])
        if (!existsSync(proof)) throw new Error('ots did not create a proof')
      } else {
        if (!existsSync(proof)) throw new Error('No OTS proof; run timestamp stamp first')
        if (action === 'upgrade') {
          const previous = readFileSync(proof)
          atomicWrite(
            safePath(this.root, `proofs/${commit}/history/${digest(previous)}.ots`),
            previous,
          )
        }
        run(['ots', action, proof])
      }
      return {
        commit,
        proof: relative + '.ots',
        state: action === 'verify' ? 'externally-verified' : 'proof-present-not-verified',
      }
    })
  }
}
