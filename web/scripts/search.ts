import * as pagefind from 'pagefind'
import type { Publication } from '../src/lib/model'

export async function indexSearch(publication: Publication, output: string) {
  const { index } = await pagefind.createIndex()
  if (!index) throw new Error('Could not create Pagefind index')
  let count = 0
  try {
    for (const day of publication.days)
      for (const entry of day.entries) {
        if (entry.track === 'gap' || entry.track === 'other') continue
        const filters = {
          date: [day.scope.day],
          source: [entry.source.split('/')[0]],
          instance: [entry.source],
          type: [entry.track],
          ...(entry.category ? { category: [entry.category] } : {}),
          ...(entry.app || entry.apps.length
            ? { app: [entry.app, ...entry.apps].filter((s): s is string => !!s) }
            : {}),
        }
        const records = [
          {
            url: entry.href,
            content: `${entry.title}\n${entry.text}`,
            title: entry.title,
          },
          ...entry.details.map((d) => ({
            url: `/days/${day.scope.day}/#${d.anchor}`,
            content: d.text,
            title: `${entry.title} · detail`,
          })),
        ]
        for (const record of records) {
          const { errors } = await index.addCustomRecord({
            url: record.url,
            content: record.content,
            language: 'en',
            filters,
            meta: {
              title: record.title,
              description: `${day.scope.day} · ${entry.source} · ${record.content.slice(0, 220)}`,
            },
            sort: { date: day.scope.day },
          })
          if (errors.length) throw new Error(errors.join('\n'))
          count++
        }
      }
    const { errors } = await index.writeFiles({ outputPath: `${output}/pagefind` })
    if (errors.length) throw new Error(errors.join('\n'))
  } finally {
    await pagefind.close()
  }
  return count
}
