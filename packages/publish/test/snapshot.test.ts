import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Repository } from '@vandelay/ddb/repository'
import { record, scope } from '@vandelay/ddb/model'
import { openPublication } from '../src/reader'

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
