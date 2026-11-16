import { defineConfig } from 'astro/config'
import react from '@astrojs/react'

export default defineConfig({
  output: 'static',
  integrations: [react()],
  base: process.env.VANDELAY_WEB_BASE || '/',
  trailingSlash: 'always',
  outDir: process.env.VANDELAY_WEB_OUT || './dist',
  cacheDir: './.cache/astro',
})
