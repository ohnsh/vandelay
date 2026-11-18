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
  repo.git('add', '.')
  repo.git('commit', '-m', 'Original')
  const commit = repo.resolveCommit('HEAD')
  const records = join(repo.root, '2026/11/14/activitywatch/test/records.jsonl')
  writeFileSync(records, 'not even valid JSON')
  const run = (revision: string) =>
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
      ],
      { cwd: root, stdout: 'pipe', stderr: 'pipe' },
    )
  const built = run(commit)
  if (built.exitCode) throw new Error(built.stderr.toString())
  const read = async (path: string) => readFileSync(join(root, 'dist', path))
  const prepared = await openPublication(read)
  expect(prepared.manifest.commit).toBe(commit)
  expect((await prepared.day(bounds.day))!.entries[0].title).toBe('Original title')
  repo.git('add', '.')
  repo.git('commit', '-m', 'Tampered inventory')
  const failed = run('HEAD')
  expect(failed.exitCode).not.toBe(0)
  expect(failed.stderr.toString()).toContain('Hash/size mismatch')
  expect((await openPublication(read)).manifest.commit).toBe(commit)
}, 30000)
