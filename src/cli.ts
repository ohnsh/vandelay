#!/usr/bin/env bun
import { Argument, Command, InvalidArgumentError, Option } from 'commander'
import { readFileSync } from 'node:fs'
import * as collectors from './collectors.ts'
import { daycap } from './daycap.ts'
import { defaultMediaArchive } from './media-archive.ts'
import { encode, expand, scope, type Source } from './model.ts'
import { Repository, type TimestampAction } from './repository.ts'

const append = (value: string, previous: string[]): string[] => [...previous, value]
const nonnegative = (value: string): number => {
  const n = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n))
    throw new InvalidArgumentError('Expected a nonnegative integer')
  return n
}
const output = (value: unknown) => {
  process.stdout.write(encode(value))
}

export function program(): Command {
  const p = new Command('did')
    .description('Collect days into Git; sign with Git, timestamp with OpenTimeStamps')
    .version('0.1.0')
    .option('--repo <path>', 'dedicated data repository', 'data')
  const repo = () => new Repository(p.opts().repo)
  p.command('init')
    .description('initialize the data repository (no commit or signing configuration)')
    .addOption(
      new Option('--object-format <format>')
        .choices(['sha256', 'sha1'])
        .default('sha256'),
    )
    .action((o) => {
      repo().init(o.objectFormat)
      output({ repository: repo().root })
    })
  p.command('collect')
    .description(
      'update one source in a day, preserving the other selected sources; does not commit',
    )
    .addArgument(new Argument('<source>').choices(['activitywatch', 'dayflow', 'daycap', 'vod']))
    .requiredOption('--day <YYYY-MM-DD>')
    .requiredOption('--timezone <IANA_ZONE>')
    .requiredOption('--instance <name>', 'stable device/archive name')
    .option('--aw-host <host>')
    .option('--aw-url <url>', 'ActivityWatch root URL', 'http://localhost:5600')
    .option('--aw-export <file>', 'AW JSON export instead of live HTTP')
    .option('--daycap-export <directory>', 'Daycap v2 export directory')
    .option(
      '--dayflow-db <path>',
      'Dayflow SQLite database',
      '~/Library/Application Support/Dayflow/chunks.sqlite',
    )
    .option(
      '--media-archive <path>',
      'permanent media archive outside Git and the source directory',
      defaultMediaArchive,
    )
    .option('--vod-root <path>', 'local media archive root')
    .option('--vod-db <path>', 'VOD SQLite snapshot')
    .option('--vod-config <path>', 'VOD JSON config for filesystem mode')
    .option('--camera <name>', 'select a camera; repeatable', append, [])
    .option(
      '--lookback-days <number>',
      'filesystem overlap scan lookback',
      nonnegative,
      1,
    )
    .action(async (source: Source, o) => {
      const r = repo()
      r.assertRepository()
      const bounds = scope(o.day, o.timezone)
      let collected
      if (source === 'activitywatch') {
        if (!o.awHost)
          throw new Error('--aw-host is required (independent of --instance)')
        collected = await collectors.activitywatch(bounds, o.awHost, o.awUrl, o.awExport)
      } else if (source === 'dayflow')
        collected = collectors.dayflow(bounds, o.dayflowDb, o.mediaArchive)
      else if (source === 'daycap') {
        if (!o.daycapExport) throw new Error('--daycap-export is required')
        collected = daycap(bounds, o.daycapExport, o.instance, o.mediaArchive)
      } else if (o.vodDb)
        collected = collectors.vodDatabase(bounds, o.vodDb, o.vodRoot, o.camera)
      else {
        if (!o.vodRoot || !o.vodConfig)
          throw new Error(
            'Filesystem VOD collection requires --vod-root and --vod-config',
          )
        collected = collectors.vodFiles(
          bounds,
          o.vodRoot,
          JSON.parse(readFileSync(expand(o.vodConfig), 'utf8')),
          o.camera,
          o.lookbackDays,
        )
      }
      output({
        ...r.collect(source, o.instance, bounds, collected),
        records: collected.records.length,
        observations: collected.observations ?? {},
      })
    })
  p.command('verify')
    .description(
      'check a day and its SHA-256 inventories (working tree, or an exact committed snapshot)',
    )
    .argument('<day>')
    .option('--commit <revision>', 'read Git blobs instead of working files')
    .option('--signature', 'also require a trusted commit signature; requires --commit')
    .action((day, o) => {
      if (o.signature && !o.commit) throw new Error('--signature requires --commit')
      const r = repo(),
        commit = o.commit ? r.resolveCommit(o.commit) : undefined
      r.verify(day, commit)
      if (o.signature) r.git('verify-commit', commit!)
      output({
        day,
        snapshot: commit ?? 'working-tree',
        integrity: 'verified',
        signature: o.signature ? 'verified' : 'not-checked',
      })
    })
  p.command('timestamp')
    .description(
      'timestamp exact signed commit bytes; proofs are working-tree changes for a later commit',
    )
    .addArgument(new Argument('<action>').choices(['stamp', 'upgrade', 'verify', 'info']))
    .argument(
      '[commit]',
      'commit revision; use the returned ID for later upgrades/verification',
      'HEAD',
    )
    .action((action: TimestampAction, commit: string) =>
      output(repo().timestamp(action, commit)),
    )
  return p
}
if (import.meta.main) {
  try {
    await program().parseAsync(process.argv)
  } catch (error) {
    console.error(`did: ${error instanceof Error ? error.message : error}`)
    process.exitCode = 1
  }
}
