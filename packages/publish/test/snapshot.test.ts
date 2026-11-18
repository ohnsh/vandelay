import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Repository } from '@vandelay/ddb/repository'
import { record, scope } from '@vandelay/ddb/model'
import { openPublication } from '../src/reader'
import { scan, emptyReview, groupFindings } from '@vandelay/autoredact'
import { digest } from '@vandelay/ddb/model'

const root = mkdtempSync(join(tmpdir(), 'vandelay-web-snapshot-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
test('preparation reads pinned blobs despite dirty working files, and rejects tampered committed inventories', async () => {
  const repo = new Repository(join(root, 'archive'))
  repo.init('sha256')
  repo.git('config', 'user.name', 'Fixture')
  repo.git('config', 'user.email', 'fixture@example.invalid')
  repo.git('config', 'commit.gpgsign', 'false')
  const bounds = scope('2026-11-14', 'UTC')
  repo.collect('activitywatch', 'test', bounds, {
    evidence: {},
    records: [
      record(
        {
          id: 'window:1',
          kind: 'activitywatch.currentwindow',
          title: 'Original title',
          time: { model: 'instant', at: '2026-11-14T12:00:00Z', basis: 'source' },
        },
        bounds,
      )!,
    ],
    coverage: { state: 'observed', method: 'fixture', limitations: [] },
  })
  repo.collect('dayflow', 'test', bounds, {
    evidence: {},
    records: [record({
      id: 'activity:1', kind: 'dayflow.activity', title: 'Dayflow title',
      time: { model: 'instant', at: '2026-11-14T12:00:00Z', basis: 'source' },
    }, bounds)!],
    coverage: { state: 'observed', method: 'fixture', limitations: [] },
  })
  repo.git('add', '.')
  repo.git('commit', '-m', 'Original')
  const commit = repo.resolveCommit('HEAD')
  const records = join(repo.root, '2026/11/14/activitywatch/test/records.jsonl')
  writeFileSync(records, 'not even valid JSON')
  const run = (revision: string, ...extra: string[]) =>
    Bun.spawnSync(
      [
        'bun',
        new URL('../src/cli.ts', import.meta.url).pathname,
        'build',
        '--repo',
        repo.root,
        '--commit',
        revision,
        '--media',
        'none',
        ...extra,
      ],
      { cwd: root, stdout: 'pipe', stderr: 'pipe' },
    )
  const built = run(commit)
  if (built.exitCode) throw new Error(built.stderr.toString())
  const read = async (path: string) => readFileSync(join(root, 'dist', path))
  const prepared = await openPublication(read)
  expect(prepared.manifest.commit).toBe(commit)
  expect((await prepared.day(bounds.day))!.entries.map(e => e.title)).toContain('Original title')
  const filtered = run(commit, '--source', 'dayflow', '--source', 'dayflow', '--channel', 'flow')
  if (filtered.exitCode) throw new Error(filtered.stderr.toString())
  const flow = await openPublication(read, { channel: 'flow' })
  expect(flow.manifest.configuration.sources).toEqual(['dayflow'])
  expect(flow.manifest.inputDigest).not.toBe(prepared.manifest.inputDigest)
  expect((await flow.day(bounds.day))!.entries.map(e => e.title)).toEqual(['Dayflow title'])
  expect((await openPublication(read)).current).toEqual(prepared.current)
  const missing = run(commit, '--source', 'daycap', '--channel', 'flow')
  expect(missing.exitCode).not.toBe(0)
  expect(missing.stderr.toString()).toContain('Selected source type absent')
  expect((await openPublication(read, { channel: 'flow' })).current).toEqual(flow.current)
  repo.git('add', '.')
  repo.git('commit', '-m', 'Tampered inventory')
  const failed = run('HEAD')
  expect(failed.exitCode).not.toBe(0)
  expect(failed.stderr.toString()).toContain('Hash/size mismatch')
  expect((await openPublication(read)).manifest.commit).toBe(commit)
}, 30000)

test('reviewed channels bind selected text, preserve discovery isolation, and block withheld or unscanned text', async () => {
  const repo = new Repository(join(root, 'review-archive'))
  repo.init('sha256')
  repo.git('config', 'user.name', 'Fixture')
  repo.git('config', 'user.email', 'fixture@example.invalid')
  repo.git('config', 'commit.gpgsign', 'false')
  const bounds = scope('2026-11-14', 'UTC')
  repo.collect('activitywatch', 'test', bounds, {
    evidence: {},
    records: [record({ id: 'window:1', kind: 'activitywatch.currentwindow', title: 'Reviewed title',
      time: { model: 'instant', at: '2026-11-14T12:00:00Z', basis: 'source' } }, bounds)!],
    coverage: { state: 'observed', method: 'fixture', limitations: [] },
  })
  repo.collect('dayflow', 'test', bounds, {
    evidence: {},
    records: [record({ id: 'activity:1', kind: 'dayflow.activity', title: 'Unscanned source',
      time: { model: 'instant', at: '2026-11-14T12:00:00Z', basis: 'source' } }, bounds)!],
    coverage: { state: 'observed', method: 'fixture', limitations: [] },
  })
  repo.git('add', '.'); repo.git('commit', '-m', 'Review fixture')
  const report = await scan([join(repo.root, '2026/11/14/activitywatch/test')])
  expect(report.status).toBe('no-findings')
  const reportPath = join(root, 'review-report.json'), reviewPath = join(root, 'review-state.json')
  const output = join(root, 'review-output')
  const save = () => {
    const bytes = JSON.stringify(report)
    writeFileSync(reportPath, bytes)
    const state = emptyReview(digest(bytes))
    for (const group of groupFindings(report)) state.decisions[group.id] = {
      decision: 'withhold', note: '', updatedAt: new Date().toISOString(),
    }
    writeFileSync(reviewPath, JSON.stringify(state))
  }
  save()
  const run = (extra: string[] = []) => Bun.spawnSync(['bun', new URL('../src/cli.ts', import.meta.url).pathname,
    'build', '--repo', repo.root, '--media', 'none', '--out', output, '--source', 'activitywatch',
    '--redaction-report', reportPath, '--redaction-review', reviewPath, ...extra],
  { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  const built = run()
  if (built.exitCode) throw new Error(built.stderr.toString())
  const read = async (path: string) => readFileSync(join(output, path))
  const prepared = await openPublication(read)
  expect(prepared.manifest.configuration.redaction?.reportSha256).toBe(digest(readFileSync(reportPath)))
  expect(prepared.manifest.configuration.sources).toEqual(['activitywatch'])
  expect((await prepared.day(bounds.day))!.entries.map(e => e.title)).toEqual(['Reviewed title'])
  const pointer = readFileSync(join(output, 'current.json'))
  const named = run(['--channel', 'reviewed'])
  if (named.exitCode) throw new Error(named.stderr.toString())
  expect((await openPublication(read, { channel: 'reviewed' })).current).toEqual(prepared.current)
  const channelPointer = readFileSync(join(output, 'channels/reviewed.json'))
  expect(run(['--source', 'dayflow', '--channel', 'reviewed']).stderr.toString()).toContain('publication-text-not-scanned')
  expect(run(['--media-urls', 'unused.json']).stderr.toString()).toContain('cannot link original')
  const text = report.inputs.find(i => i.path.endsWith('records.jsonl'))!
  report.findings.push({ id: digest('finding'), source: text.path, pointer: 'line:1#/title',
    rule: 'manual-fixture', severity: 'review', pass: 'text' })
  report.status = 'findings'
  save()
  const withheld = run(['--channel', 'reviewed'])
  expect(withheld.exitCode).not.toBe(0)
  expect(withheld.stderr.toString()).toContain('publication-text-withheld')
  report.findings = []; report.status = 'no-findings'
  report.inputs = report.inputs.filter(i => i.path !== text.path)
  save()
  expect(run(['--channel', 'reviewed']).stderr.toString()).toContain('publication-text-not-scanned')
  expect(readFileSync(join(output, 'current.json'))).toEqual(pointer)
  expect(readFileSync(join(output, 'channels/reviewed.json'))).toEqual(channelPointer)
}, 30000)
