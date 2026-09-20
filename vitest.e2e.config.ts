import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.e2e.ts'],
    testTimeout: 90_000,
    hookTimeout: 90_000,
    fileParallelism: false
  }
})
