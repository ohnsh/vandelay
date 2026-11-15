import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { digest, encode } from '../../src/model'
import { prepare } from './prepare'
import { indexSearch } from './search'

const start = performance.now()
// A concurrent writer could otherwise replace .data while Astro is reading it.
mkdirSync('.data', { recursive: true })
try {
  mkdirSync('.data/build.lock')
} catch {
  throw new Error('Another web build is active (.data/build.lock)')
}
const stage = `.dist-${process.pid}`
try {
  const { publication, assets } = await prepare(process.argv.slice(2))
  const child = Bun.spawn(['bun', 'x', '--no-install', 'astro', 'build'], {
    env: { ...process.env, DID_WEB_OUT: `./${stage}` },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (await child.exited) throw new Error('Astro build failed')
  mkdirSync(`${stage}/media`, { recursive: true })
  for (const asset of assets)
    cpSync(
      join('.cache/media', asset.path.split('/').at(-1)!),
      join(stage, asset.path.slice(1)),
    )
  const searchRecords = await indexSearch(publication, stage)
  const walk = (
    root: string,
    prefix = '',
  ): { path: string; sha256: string; bytes: number }[] =>
    readdirSync(join(root, prefix))
      .sort()
      .flatMap((name) => {
        const path = join(prefix, name),
          full = join(root, path)
        return statSync(full).isDirectory()
          ? walk(root, path)
          : [{ path, sha256: digest(readFileSync(full)), bytes: statSync(full).size }]
      })
  const generatorFiles = ['src', 'scripts'].flatMap((root) =>
    walk(root).map((f) => ({ ...f, path: `${root}/${f.path}` })),
  )
  const outputs = walk(stage)
  writeFileSync(
    `${stage}/publication.json`,
    JSON.stringify(
      {
        schema: 'did.publication/v1',
        commit: publication.commit,
        generator: publication.generator,
        generatorDigest: digest(
          encode({
            generatorFiles,
            config: readFileSync('astro.config.mjs', 'utf8'),
            lock: digest(readFileSync('../bun.lock')),
          }),
        ),
        inputDigest: publication.inputDigest,
        base: process.env.DID_WEB_BASE || '/',
        verification: publication.verification,
        days: publication.days.map((d) => ({ scope: d.scope, sources: d.sources })),
        derivatives: assets,
        outputs,
        searchRecords,
      },
      null,
      2,
    ) + '\n',
  )
  // Stage everything before replacing dist. Failed preparation/build/search leaves the previous dist intact.
  const previous = '.dist-previous'
  rmSync(previous, { recursive: true, force: true })
  if (existsSync('dist')) renameSync('dist', previous)
  try {
    renameSync(stage, 'dist')
  } catch (error) {
    if (existsSync(previous)) renameSync(previous, 'dist')
    throw error
  }
  rmSync(previous, { recursive: true, force: true })
  console.log(
    JSON.stringify(
      {
        output: resolve('dist'),
        commit: publication.commit,
        searchRecords,
        files: outputs.length + 1,
        bytes:
          outputs.reduce((sum, f) => sum + f.bytes, 0) +
          statSync('dist/publication.json').size,
        seconds: Math.round((performance.now() - start) / 100) / 10,
      },
      null,
      2,
    ),
  )
} finally {
  rmSync(stage, { recursive: true, force: true })
  rmSync('.data/build.lock', { recursive: true, force: true })
}
