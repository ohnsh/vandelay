import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './browser',
  testMatch: '*.pw.ts',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4325', browserName: 'chromium' },
  webServer: {
    command: 'bun run preview --port 4325',
    env: { ASTRO_PREVIEW_BACKGROUND: '0' },
    url: `http://127.0.0.1:4325${(process.env.DID_WEB_BASE || '').replace(/\/$/, '')}/`,
    reuseExistingServer: false,
  },
})
