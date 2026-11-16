import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('ddb forwards scan arguments and preserves scan exit statuses', () => {
  const root = mkdtempSync(join(tmpdir(), 'vandelay-scan-'))
  const cli = new URL('../src/cli.ts', import.meta.url).pathname
  const run = (...args: string[]) =>
    Bun.spawnSync([process.execPath, cli, 'scan', ...args])
  try {
    const input = join(root, 'input.txt')
    writeFileSync(input, 'A sunny afternoon.')
    const clean = run(input, '--json')
    expect(clean.exitCode).toBe(0)
    expect(JSON.parse(clean.stdout.toString()).status).toBe('no-findings')
    writeFileSync(input, 'API_KEY=synthetic-secret-for-testing')
    const flagged = run(input, '--json')
    expect(flagged.exitCode).toBe(1)
    expect(JSON.parse(flagged.stdout.toString()).status).toBe('findings')
    expect(run(join(root, 'missing.txt'), '--json').exitCode).toBe(2)
    expect(run(input, '--mapping', join(root, 'missing.json')).exitCode).toBe(2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
