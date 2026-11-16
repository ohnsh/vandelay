import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { result } from '../src/collectors.ts';
import { command } from '../src/io.ts';
import { digest, encode, instant, record, scope, type Source } from '../src/model.ts';
import { Repository } from '../src/repository.ts';

let root: string, repo: Repository;
const bounds = scope('2026-11-12', 'America/Chicago');
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vandelay-test-'));
  repo = new Repository(join(root, 'data')); repo.init();
  repo.git('config', 'user.name', 'Fixture');
  repo.git('config', 'user.email', 'fixture@example.invalid');
  repo.git('config', 'commit.gpgsign', 'false');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function collect(text = 'hello', source: Source = 'dayflow') {
  const r = record({ id: '1', kind: 'fixture', time: { model: 'interval', start: bounds.start, end: bounds.end, basis: 'fixture' }, text }, bounds)!;
  return repo.collect(source, 'mac', bounds, result([r], { raw: text }, 'fixture', []));
}
function commit() {
  repo.git('add', '.'); repo.git('commit', '-m', 'Collect day');
  return repo.resolveCommit('HEAD');
}
function signing() {
  const key = join(root, 'signing');
  command(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', key]);
  const allowed = join(root, 'allowed_signers');
  writeFileSync(allowed, 'fixture@example.invalid ' + readFileSync(key + '.pub', 'utf8'));
  repo.git('config', 'gpg.format', 'ssh');
  repo.git('config', 'user.signingkey', key);
  repo.git('config', 'gpg.ssh.allowedSignersFile', allowed);
  repo.git('config', 'commit.gpgsign', 'true');
}

test('date paths, ordinary hashes, source replacement, idempotence and Git history', () => {
  expect(collect().changed).toBe(true);
  const first = commit();
  expect(first).toHaveLength(64);
  expect(collect().changed).toBe(false);
  expect(repo.git('status', '--porcelain').toString()).toBe('');
  collect('second source', 'activitywatch');
  collect('revised');
  const second = commit();
  const day = repo.verify(bounds.day), old = repo.verify(bounds.day, first);
  expect(Object.keys(day.sources)).toHaveLength(2);
  expect(Object.keys(old.sources)).toHaveLength(1);
  expect(day.sources['dayflow/mac'].sha256).not.toBe(old.sources['dayflow/mac'].sha256);
  const ref = day.sources['dayflow/mac'];
  expect(digest(repo.git('cat-file', 'blob', `${second}:${ref.path}`))).toBe(ref.sha256);
  expect(repo.git('rev-parse', `${second}:${ref.path}`).toString().trim()).not.toBe(ref.sha256);
});

test('tampering fails, while historical verification reads exact blobs', () => {
  collect(); const id = commit();
  writeFileSync(join(repo.root, '2026/11/12/dayflow/mac/evidence.json'), '{}\n');
  expect(() => repo.verify(bounds.day)).toThrow('Hash/size');
  expect(() => collect()).toThrow('Hash/size');
  expect(repo.verify(bounds.day, id).scope).toEqual(bounds);
});

test('collection and verification validate envelope semantics, not only hashes', () => {
  collect();
  const prefix = '2026/11/12/dayflow/mac';
  const path = join(repo.root, prefix, 'records.jsonl');
  const item = JSON.parse(readFileSync(path, 'utf8'));
  expect(item.schema).toBe('vandelay.record/v1');
  expect(() => repo.collect('dayflow', 'mac', bounds, result([item, item], {}, 'fixture', []))).toThrow('Duplicate');
  const invalid = { ...item, placement: { model: 'instant', at: bounds.end } };
  expect(() => repo.collect('dayflow', 'mac', bounds, result([invalid], {}, 'fixture', []))).toThrow('placement');
  // Recompute all hashes: semantic invalidity must still be rejected.
  const bytes = encode(invalid);
  writeFileSync(path, bytes);
  const manifestPath = join(repo.root, prefix, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  expect(manifest.schema).toBe('vandelay.bundle/v1');
  expect(manifest.record_schema).toBe('vandelay.record/v1');
  manifest.files['records.jsonl'] = { bytes: bytes.length, sha256: digest(bytes) };
  const manifestBytes = encode(manifest);
  writeFileSync(manifestPath, manifestBytes);
  const dayPath = join(repo.root, '2026/11/12.json');
  const day = JSON.parse(readFileSync(dayPath, 'utf8'));
  day.sources['dayflow/mac'] = { path: `${prefix}/manifest.json`, bytes: manifestBytes.length, sha256: digest(manifestBytes) };
  writeFileSync(dayPath, encode(day));
  expect(() => repo.verify(bounds.day)).toThrow('placement');
});

test('reject scope collisions, traversal and escaped output paths', () => {
  collect();
  expect(() => repo.collect('dayflow', 'mac', scope(bounds.day, 'UTC'), result([], {}, 'fixture', []))).toThrow('one timezone');
  expect(() => repo.collect('dayflow', '../bad', bounds, result([], {}, 'fixture', []))).toThrow('Instance');
  mkdirSync(join(root, 'outside'));
  symlinkSync(join(root, 'outside'), join(repo.root, '2027'));
  expect(() => repo.collect('dayflow', 'mac', scope('2027-01-01', 'UTC'), result([], {}, 'fixture', []))).toThrow('escapes');
});

test('signed commit bytes are timestamp subjects, upgrades retain old proofs, failures propagate', () => {
  signing(); collect(); const id = commit();
  repo.git('verify-commit', id);
  const bytes = repo.git('cat-file', 'commit', id);
  expect(bytes.toString()).toContain('gpgsig');
  expect(bytes.toString()).toContain('BEGIN SSH SIGNATURE');
  const subject = join(repo.root, `proofs/${id}/commit`), proof = subject + '.ots';
  const stamped = repo.timestamp('stamp', id, args => {
    expect(args).toEqual(['ots', 'stamp', subject]);
    expect(readFileSync(subject).equals(bytes)).toBe(true);
    writeFileSync(proof, 'pending');
  });
  expect(stamped.state).toBe('proof-present-not-verified');
  repo.timestamp('stamp', id, () => { throw new Error('must not re-stamp'); });
  repo.timestamp('upgrade', id, args => {
    expect(args).toEqual(['ots', 'upgrade', proof]); writeFileSync(proof, 'anchored');
  });
  expect(readFileSync(join(repo.root, `proofs/${id}/history/${digest('pending')}.ots`), 'utf8')).toBe('pending');
  expect(() => repo.timestamp('verify', id, () => { throw new Error('offline'); })).toThrow('offline');
  expect(repo.timestamp('verify', id, () => {}).state).toBe('externally-verified');
  // Committing proof material leaves the timestamped commit and subject unchanged.
  commit();
  expect(readFileSync(subject).equals(bytes)).toBe(true);
  expect(repo.timestamp('info', id, () => {}).commit).toBe(id);
  writeFileSync(subject, 'substituted');
  expect(() => repo.timestamp('verify', id, () => {})).toThrow('differs');
});

test('timestamp rejects unsigned commits and untrusted signatures', () => {
  collect(); const unsigned = commit();
  expect(() => repo.timestamp('stamp', unsigned, () => {})).toThrow();
  signing(); collect('signed'); const signed = commit();
  writeFileSync(join(root, 'allowed_signers'), '');
  expect(() => repo.timestamp('stamp', signed, () => {})).toThrow();
});

test('SHA-1 repositories also support signed timestamps', () => {
  repo = new Repository(join(root, 'sha1')); repo.init('sha1');
  repo.git('config', 'user.name', 'Fixture'); repo.git('config', 'user.email', 'fixture@example.invalid');
  signing(); collect(); const id = commit();
  expect(id).toHaveLength(40);
  repo.timestamp('stamp', id, args => writeFileSync(args[2] + '.ots', 'pending'));
});

test('CLI defaults to the runtime timezone, with explicit timezone taking precedence', () => {
  const exported = join(root, 'aw.json');
  writeFileSync(exported, encode({ buckets: { window: { hostname: 'mac', type: 'window', events: [] } } }));
  const cli = [process.execPath, new URL('../src/cli.ts', import.meta.url).pathname, '--repo', repo.root,
    'collect', 'activitywatch', '--instance', 'mac', '--aw-host', 'mac', '--aw-export', exported];
  command([...cli, '--day', '2026-03-08'], { env: { ...process.env, TZ: 'America/New_York' } });
  expect(repo.verify('2026-03-08').scope).toEqual(scope('2026-03-08', 'America/New_York'));
  command([...cli, '--day', '2026-03-09', '--timezone', 'UTC'], { env: { ...process.env, TZ: 'invalid/zone' } });
  expect(repo.verify('2026-03-09').scope).toEqual(scope('2026-03-09', 'UTC'));
  const env = { ...process.env };
  delete env.TZ;
  const systemZone = command([process.execPath, '-e', 'console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)'], { env }).toString().trim();
  command([...cli, '--day', '2026-03-11'], { env });
  expect(repo.verify('2026-03-11').scope).toEqual(scope('2026-03-11', systemZone));
});

test('CLI collects offline AW data, verifies signed historical snapshots, and reports source errors', () => {
  const exported = join(root, 'aw.json');
  writeFileSync(exported, encode({ buckets: { window: { hostname: 'mac', type: 'window', events: [
    { id: 1, timestamp: bounds.start, duration: 5, data: { app: 'Editor' } },
  ] } } }));
  const cli = [process.execPath, new URL('../src/cli.ts', import.meta.url).pathname, '--repo', repo.root];
  const args = ['collect', 'activitywatch', '--day', bounds.day, '--timezone', bounds.timezone, '--instance', 'mac', '--aw-host', 'mac', '--aw-export', exported];
  expect(JSON.parse(command([...cli, ...args]).toString()).changed).toBe(true);
  expect(JSON.parse(command([...cli, ...args]).toString()).changed).toBe(false);
  signing(); const id = commit();
  expect(JSON.parse(command([...cli, 'verify', bounds.day, '--commit', id, '--signature']).toString()).signature).toBe('verified');
  expect(() => command([...cli, ...args, '--aw-host', 'missing'], { stdio: 'pipe' })).toThrow();
  expect(repo.git('status', '--porcelain').toString()).toBe('');
});
