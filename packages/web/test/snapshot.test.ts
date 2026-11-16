import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Repository } from '@vandelay/ddb/repository'
import { record, scope } from '@vandelay/ddb/model'

const root = mkdtempSync(join(tmpdir(), 'vandelay-web-snapshot-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
test('preparation reads pinned blobs despite dirty working files, and rejects tampered committed inventories', () => {
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
        new URL('../scripts/prepare.ts', import.meta.url).pathname,
        '--repo',
        repo.root,
        '--commit',
        revision,
        '--media',
        'none',
      ],
      { cwd: root, stdout: 'pipe', stderr: 'pipe' },
    )
  expect(run(commit).exitCode).toBe(0)
  const prepared = JSON.parse(readFileSync(join(root, '.data/prepared.json'), 'utf8'))
  expect(prepared.publication.commit).toBe(commit)
  expect(prepared.publication.days[0].entries[0].title).toBe('Original title')
  repo.git('add', '.')
  repo.git('commit', '-m', 'Tampered inventory')
  const failed = run('HEAD')
  expect(failed.exitCode).not.toBe(0)
  expect(failed.stderr.toString()).toContain('Hash/size mismatch')
  expect(
    JSON.parse(readFileSync(join(root, '.data/prepared.json'), 'utf8')).publication
      .commit,
  ).toBe(commit)
}, 30000)
