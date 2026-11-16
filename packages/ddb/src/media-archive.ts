import { randomUUID } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { expand, fileHash, safePath, type Media } from './model.ts'

export const defaultMediaArchive = '~/.local/share/vandelay/media'

export function archiveRoot(path: string, sourceDirectory: string): string {
  const root = expand(path)
  mkdirSync(root, { recursive: true })
  const actual = realpathSync(root),
    source = realpathSync(sourceDirectory)
  const rel = relative(source, actual)
  if (rel === '' || (rel !== '..' && !rel.startsWith('..' + sep)))
    throw new Error('Media archive must be outside the source directory')
  for (let parent = actual; ; parent = dirname(parent)) {
    if (
      existsSync(join(parent, '.git')) ||
      (existsSync(join(parent, 'HEAD')) && existsSync(join(parent, 'objects')))
    ) {
      throw new Error('Media archive must be outside Git repositories')
    }
    if (dirname(parent) === parent) break
  }
  return actual
}

function stamp(path: string): string {
  const s = statSync(path, { bigint: true })
  if (!s.isFile()) throw new Error(`Not a media file: ${path}`)
  return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':')
}

// Publish only complete, verified copies; never overwrite a content-addressed object.
export function archiveMedia(source: string, root: string): Media {
  const temporary = join(root, '.vandelay-' + randomUUID())
  try {
    const before = stamp(source)
    copyFileSync(source, temporary)
    const sha256 = fileHash(temporary),
      bytes = statSync(temporary).size
    if (fileHash(source) !== sha256 || stamp(source) !== before)
      throw new Error(`Media changed while archiving: ${source}`)
    const path = `sha256/${sha256.slice(0, 2)}/${sha256}`
    const target = safePath(root, path)
    mkdirSync(dirname(target), { recursive: true })
    const fd = openSync(temporary, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    try {
      linkSync(temporary, target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    if (statSync(target).size !== bytes || fileHash(target) !== sha256)
      throw new Error(`Corrupt archive object: ${target}`)
    return {
      sha256,
      bytes,
      role: 'original',
      location: { kind: 'archive-relative', path },
      availability: 'archived',
    }
  } finally {
    rmSync(temporary, { force: true })
  }
}
