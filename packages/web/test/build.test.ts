import { afterAll, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, expect as browserExpect } from '@playwright/test'
import { digest, scope } from '@vandelay/ddb/model'
import type { Asset, Publication } from '@vandelay/publish/model'
import { writePublication } from '../../publish/src/store'
import { run } from '../../publish/src/media'

const root = mkdtempSync(join(tmpdir(), 'vandelay-web-consumer-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
test('build consumes only publication artifacts; day/activity playback shares chunks across boundaries', async () => {
  const cache = join(root, 'cache'), output = join(root, 'publication')
  mkdirSync(join(cache, 'media'), { recursive: true })
  const assets: Asset[] = []
  for (const color of ['red', 'blue']) {
    const temp = join(root, `${color}.mp4`)
    await run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:size=128x72:rate=4:duration=0.75`,
      '-c:v', 'libx264', '-threads', '1', '-bf', '0', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', temp])
    const bytes = readFileSync(temp), hash = digest(bytes), path = `media/${hash}.mp4`
    await Bun.write(join(cache, path), bytes)
    assets.push({ path, sha256: hash, bytes: bytes.length, mediaType: 'video/mp4', recipe: 'fixture', inputs: [] })
  }
  const bounds = scope('2026-11-14', 'UTC')
  const frames = Array.from({ length: 6 }, (_, i) => ({
    key: `frame-${i}`, anchor: `frame-${i}`, source: 'daycap/fixture', recordID: `capture/${i}`,
    at: `2026-11-14T00:00:0${i}Z`, time: { model: 'instant' as const, at: `2026-11-14T00:00:0${i}Z`, basis: 'capture' },
    disposition: 'captured', previewStatus: 'prepared',
    playback: { asset: assets[Math.floor(i / 3)].path, offset: (i % 3) / 4, duration: .25 },
  }))
  const clip = { label: 'All captures', selection: 'day' as const, frameKeys: frames.map(f => f.key) }
  const publication: Publication = {
    schema: 'vandelay.publish/v1', commit: 'a'.repeat(40), generator: 'fixture', generatorDigest: digest('fixture'),
    configuration: { media: 'all', captureStride: 1 }, inputDigest: digest('fixture'),
    verification: { archive: 'verified', signature: 'not checked', timestamp: 'not checked' },
    days: [{
      schema: 'vandelay.publish.day/v1', scope: bounds,
      sources: [{ slot: 'daycap/fixture', count: 7, limitations: [], manifest: 'fixture', sha256: digest('manifest') }],
      frames, timelapses: [{ source: 'daycap/fixture', clip }],
      entries: [{
        status: 'active', anchor: 'activity', recordID: 'activity', source: 'daycap/fixture',
        kind: 'daycap.journal.activity', track: 'activity', title: 'Shared timelapse',
        text: 'Every capture in the activity interval.',
        time: { model: 'interval', start: bounds.start, end: '2026-11-14T00:00:06Z', basis: 'fixture' },
        placement: { model: 'interval', start: bounds.start, end: '2026-11-14T00:00:06Z' },
        apps: [], details: [], links: [], frameKeys: ['frame-0'], provenance: 'fixture',
        clip: { ...clip, selection: 'activity-time-range' },
      }],
    }],
  }
  writePublication(output, publication, assets, cache)
  const app = join(root, 'app')
  mkdirSync(app)
  const packageRoot = new URL('../', import.meta.url).pathname
  cpSync(join(packageRoot, 'src'), join(app, 'src'), { recursive: true })
  for (const file of ['scripts', 'node_modules', 'astro.config.mjs', 'package.json', 'tsconfig.json'])
    symlinkSync(join(packageRoot, file), join(app, file))
  const build = Bun.spawn(['bun', join(packageRoot, 'scripts/build.ts'), '--publication', output, '--copy-media'], {
    cwd: app, env: { ...process.env, VANDELAY_WEB_BASE: '/nested' }, stdout: 'pipe', stderr: 'pipe',
  })
  const [stdout, stderr, status] = await Promise.all([
    new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited,
  ])
  if (status) throw new Error(`${stdout}\n${stderr}`)
  const html = readFileSync(join(app, 'dist/days/2026-11-14/index.html'), 'utf8')
  expect(html).toContain('Shared timelapse')
  expect(html).toContain('Screen timelapses')
  expect(html).toContain(`/nested/${assets[0].path}`)
  const provenance = JSON.parse(readFileSync(join(app, 'dist/publication.json'), 'utf8'))
  expect(provenance.publication.path).toMatch(/^publications\/[a-f0-9]{64}\/manifest.json$/)
  expect(provenance.derivatives).toHaveLength(2)
  for (const asset of assets) expect(digest(readFileSync(join(app, 'dist', asset.path)))).toBe(asset.sha256)
  // Hosted mode does not require local media or copy videos into the deployment.
  rmSync(join(output, 'media'), { recursive: true })
  const hosted = Bun.spawn(['bun', join(packageRoot, 'scripts/build.ts'), '--publication', output,
    '--asset-base', 'https://assets.example.test'], {
    cwd: app, env: { ...process.env, VANDELAY_WEB_OUT: undefined }, stdout: 'pipe', stderr: 'pipe',
  })
  const [hostedOut, hostedErr, hostedStatus] = await Promise.all([
    new Response(hosted.stdout).text(), new Response(hosted.stderr).text(), hosted.exited,
  ])
  if (hostedStatus) throw new Error(`${hostedOut}\n${hostedErr}`)
  expect(existsSync(join(app, 'dist/media'))).toBe(false)
  expect(readFileSync(join(app, 'dist/days/2026-11-14/index.html'), 'utf8')).toContain('https://assets.example.test/media/')
  if (!existsSync(chromium.executablePath())) {
    console.log('Browser playback check skipped: install Chromium with bunx playwright install chromium')
    return
  }
  // Serve the hosted-mode site and intercept asset requests with the verified local fixture.
  const server = Bun.serve({ port: 0, async fetch(request) {
    let path = new URL(request.url).pathname
    if (path.endsWith('/')) path += 'index.html'
    const file = Bun.file(join(app, 'dist', path))
    return await file.exists() ? new Response(file) : new Response('Not found', { status: 404 })
  } })
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('https://assets.example.test/**', async route => {
      const path = new URL(route.request().url()).pathname
      await route.fulfill({ body: readFileSync(join(cache, path)), contentType: 'video/mp4' })
    })
    await page.goto(`http://localhost:${server.port}/days/2026-11-14/`)
    await page.locator('#activity .media-disclosure summary').click()
    await page.locator('#activity video').scrollIntoViewIfNeeded()
    await browserExpect(page.locator('#activity astro-island')).not.toHaveAttribute('ssr', '')
      .catch(error => { throw new Error(`${error}\nBrowser errors: ${errors.join('\n')}`) })
    const video = page.locator('#activity video')
    await video.evaluate((v: HTMLVideoElement) => v.play())
    await browserExpect.poll(async () => video.evaluate((v: HTMLVideoElement) => v.currentSrc), { timeout: 10000 })
      .toBe(`https://assets.example.test/${assets[1].path}`)
    await video.evaluate((v: HTMLVideoElement) => v.pause())
    await page.locator('#activity input[type=range]').fill('0')
    await browserExpect.poll(async () => video.evaluate((v: HTMLVideoElement) => v.currentSrc))
      .toBe(`https://assets.example.test/${assets[0].path}`)
    expect(errors).toEqual([])
  } finally { await browser.close(); server.stop(true) }
}, 120000)
