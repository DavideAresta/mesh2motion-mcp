// Copied into the Mesh2Motion checkout by scripts/setup-app.mjs.
// Same settings as the app's vite.config.js, but it only builds the MCP bridge
// page and does not embed the build machine's environment variables.
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import glsl from 'vite-plugin-glsl'

export default defineConfig({
  root: 'src/',
  publicDir: '../static/',
  base: './',
  define: {
    PROCESS_ENV: JSON.stringify({
      WORKERS_CI_COMMIT_SHA: process.env.M2M_APP_COMMIT ?? 'unknown',
      WORKERS_CI_BRANCH: 'mcp-bridge'
    })
  },
  logLevel: 'warn',
  build: {
    outDir: '../dist-mcp',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      input: {
        bridge: resolve(import.meta.dirname, 'src/mcp-bridge.html')
      }
    }
  },
  plugins: [glsl()]
})
