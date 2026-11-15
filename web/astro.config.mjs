import { defineConfig } from 'astro/config'
import react from '@astrojs/react'

export default defineConfig({
  output: 'static',
  integrations: [react()],
  base: process.env.DID_WEB_BASE || '/',
  trailingSlash: 'always',
  outDir: process.env.DID_WEB_OUT || './dist',
  cacheDir: './.cache/astro',
})
