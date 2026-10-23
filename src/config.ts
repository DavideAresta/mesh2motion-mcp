import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function env_flag (name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase()
  if (value === undefined || value === '') return fallback
  return !['0', 'false', 'no', 'off'].includes(value)
}

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Mesh2Motion checkout prepared by scripts/setup-app.mjs */
export const APP_DIR = path.resolve(process.env.M2M_APP_DIR ?? path.join(PROJECT_ROOT, 'vendor', 'mesh2motion-app'))
export const DIST_DIR = path.join(APP_DIR, 'dist-mcp')
export const BRIDGE_PAGE = 'mcp-bridge.html'

/** Where relative export/screenshot paths are written */
export const OUTPUT_DIR = path.resolve(process.env.M2M_OUTPUT_DIR ?? path.join(PROJECT_ROOT, 'output'))

/** Set M2M_HEADLESS=0 to watch the app work in a visible browser window */
export const HEADLESS = env_flag('M2M_HEADLESS', true)

/**
 * Force a browser: "chrome", "msedge", or "chromium" (Playwright's Chromium only).
 * Default: Playwright's Chromium if installed, then Chrome, then Edge.
 */
export const BROWSER_CHANNEL = process.env.M2M_BROWSER_CHANNEL?.trim().toLowerCase() || undefined

/** Download Playwright's Chromium when no usable browser is found (M2M_AUTO_INSTALL_BROWSER=0 to disable) */
export const AUTO_INSTALL_BROWSER = env_flag('M2M_AUTO_INSTALL_BROWSER', true)

export const VIEWPORT = { width: 1280, height: 860 }

export function expand_home (input: string): string {
  if (input === '~') return os.homedir()
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2))
  return input
}

/** Input files: absolute, ~, or relative to the server's working directory */
export function resolve_input_path (input: string): string {
  return path.resolve(expand_home(input))
}

/** Output files: absolute, ~, or relative to OUTPUT_DIR */
export function resolve_output_path (input: string): string {
  const expanded = expand_home(input)
  return path.isAbsolute(expanded) ? expanded : path.resolve(OUTPUT_DIR, expanded)
}
