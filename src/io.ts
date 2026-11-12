import { dlopen, FFIType } from 'bun:ffi';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync, type SpawnSyncOptionsWithBufferEncoding } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const libc = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});

// Lock lives in Git's private directory, never among the collected files.
export function withLock<T>(gitDir: string, fn: () => T): T {
  const fd = openSync(join(gitDir, 'did.lock'), 'a', 0o600);
  try {
    if (libc.symbols.flock(fd, 2) !== 0) throw new Error('Cannot acquire did lock');
    return fn();
  } finally { libc.symbols.flock(fd, 8); closeSync(fd); }
}

export function atomicWrite(path: string, content: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), '.did-' + randomUUID());
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

export function command(argv: string[], options: SpawnSyncOptionsWithBufferEncoding = {}): Buffer {
  const p = spawnSync(argv[0], argv.slice(1), { maxBuffer: 128 * 1024 * 1024, stdio: ['pipe', 'pipe', 'inherit'], ...options });
  if (p.error) throw p.error;
  if (p.status !== 0) throw new Error(`${argv[0]} exited ${p.status ?? p.signal}`);
  return p.stdout ?? Buffer.alloc(0);
}
