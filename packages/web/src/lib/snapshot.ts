import { readFileSync } from 'node:fs'
import type { Publication } from './model'

// Astro reads only this publication projection, never Git, databases or original evidence.
export const publication: Publication = JSON.parse(
  readFileSync('.data/prepared.json', 'utf8'),
).publication
