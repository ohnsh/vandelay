import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import type { Publication } from '../src/lib/model'

const pub: Publication = JSON.parse(
  readFileSync('.data/prepared.json', 'utf8'),
).publication
const base = (process.env.VANDELAY_WEB_BASE || '/').replace(/\/$/, '')
const path = (p: string) => `${base}${p}`
test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    return url.hostname === '127.0.0.1' || url.protocol === 'data:'
      ? route.continue()
      : route.abort()
  })
})
test('calendar, source comparison, detail deep link and capture navigation', async ({
  page,
}) => {
  const day = pub.days.find((d) => d.sources.some((s) => s.slot.startsWith('daycap/')))!
  const entry = day.entries.find(
    (e) =>
      e.track === 'activity' && e.details.some((d) => d.supports.some((s) => s.href)),
  )!
  const detail = entry.details.find((d) => d.supports.some((s) => s.href))!
  await page.goto(path('/'))
  await page.locator(`a[href="${path(`/days/${day.scope.day}/`)}"]`).click()
  await expect(page.locator('#activity .entry')).toHaveCount(
    day.entries.filter((e) => e.track === 'activity').length,
  )
  const other = day.sources.find((s) => s.slot !== entry.source)!
  await page.locator('#source-filter').selectOption(other.slot)
  await expect(page.locator(`#${entry.anchor}`)).toBeHidden()
  await page.goto(
    path(
      `/days/${day.scope.day}/?source=${encodeURIComponent(other.slot)}#${detail.anchor}`,
    ),
  )
  await expect(page.locator(`#${detail.anchor}`)).toBeVisible()
  await page.reload()
  await expect(page.locator(`#${detail.anchor}`)).toBeVisible()
  const citation = detail.supports.find((s) => s.href)!
  await page.locator(`#${detail.anchor} a[href="${path(citation.href!)}"]`).click()
  await expect(page.locator(`#${citation.href!.split('#')[1]}`)).toBeVisible()
})
test('Pagefind query, filters and detail result survive reload', async ({ page }) => {
  const day = pub.days.find((d) => d.sources.some((s) => s.slot.startsWith('daycap/')))!
  const e = day.entries.find((e) => e.source.startsWith('daycap/') && e.details.length)!
  const query = e.details[0].text.match(/[A-Za-z]{5,}/)?.[0] ?? 'activity'
  await page.goto(path(`/search/?q=${encodeURIComponent(query)}&source=daycap`))
  await expect(page.locator('#results li').first()).toBeVisible()
  const result = page.locator('#results a[href*="-d-"]').first()
  await expect(result).toBeVisible()
  const href = await result.getAttribute('href')
  expect(href).toContain(`${base}/days/`)
  await result.click()
  await expect(page.locator(`[id="${href!.split('#')[1]}"]`)).toBeVisible()
  await page.reload()
  await expect(page.locator(`[id="${href!.split('#')[1]}"]`)).toBeVisible()
})
test('native video decodes, React frame seek updates wall clock, and mobile fits', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const day = pub.days.find((d) =>
    d.entries.some((e) => e.clip?.frames.length && e.clip.frames.length > 1),
  )!
  const e = day.entries.find((e) => e.clip && e.clip.frames.length > 1)!
  await page.goto(path(`/days/${day.scope.day}/#${e.anchor}`))
  await page.locator(`#${e.anchor} .media-disclosure summary`).click()
  const video = page.locator(`#${e.anchor} video`)
  await video.evaluate((v: HTMLVideoElement) => v.play())
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(0)
  await video.evaluate((v: HTMLVideoElement) => v.pause())
  const seek = page.locator(`#${e.anchor} input[type=range]`)
  await seek.fill('1')
  await expect(page.locator(`#${e.anchor} .player-caption a`)).toHaveAttribute(
    'href',
    path(e.clip!.frames[1].href),
  )
  await page.setViewportSize({ width: 390, height: 844 })
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true)
  expect(errors).toEqual([])
})
test('static narrative is readable without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false })
  const page = await context.newPage()
  const day = pub.days.find((d) => d.entries.some((e) => e.track === 'activity'))!
  await page.goto(`http://127.0.0.1:4325${path(`/days/${day.scope.day}/`)}`)
  await expect(page.locator('#activity .entry').first()).toBeVisible()
  await context.close()
})
