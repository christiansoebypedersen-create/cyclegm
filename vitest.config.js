import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// Dedicated config for the headless render smoke test.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',   // smoke.test.jsx opts into jsdom via its @vitest-environment docblock
    globals: true,
    include: ['test/**/*.test.{js,jsx}'],
  },
})
