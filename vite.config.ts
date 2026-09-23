import { defineConfig } from 'vitest/config'
import { apiPlugin } from './src/server/plugin'

export default defineConfig({
  plugins: [apiPlugin()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000
  }
})
