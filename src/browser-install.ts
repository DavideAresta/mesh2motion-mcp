import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { chromium } from 'playwright'

export type SystemChannel = 'chrome' | 'msedge'

/** Where Chrome and Edge install themselves; Playwright's "chrome"/"msedge" channels launch from these. */
function system_browser_candidates (): Array<{ channel: SystemChannel, path: string }> {
  if (process.platform === 'darwin') {
    return [
      { channel: 'chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      { channel: 'msedge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' }
    ]
  }

  if (process.platform === 'win32') {
    const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]
      .filter((root): root is string => root !== undefined)
    return [
      ...roots.map(root => ({ channel: 'chrome' as const, path: path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe') })),
      ...roots.map(root => ({ channel: 'msedge' as const, path: path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe') }))
    ]
  }

  return [
    { channel: 'chrome', path: '/opt/google/chrome/chrome' },
    { channel: 'msedge', path: '/opt/microsoft/msedge/msedge' }
  ]
}

export function find_system_browser (): SystemChannel | undefined {
  return system_browser_candidates().find(candidate => fs.existsSync(candidate.path))?.channel
}

export function bundled_chromium_installed (): boolean {
  return fs.existsSync(chromium.executablePath())
}

let install_promise: Promise<void> | null = null

/**
 * Downloads Playwright's Chromium (into ~/.cache/ms-playwright, or PLAYWRIGHT_BROWSERS_PATH).
 * Concurrent callers share the same download; a failed download can be retried.
 */
export async function install_bundled_chromium (): Promise<void> {
  if (install_promise === null) {
    install_promise = run_install().catch((error: unknown) => {
      install_promise = null
      throw error
    })
  }
  await install_promise
}

async function run_install (): Promise<void> {
  const playwright_dir = path.dirname(createRequire(import.meta.url).resolve('playwright/package.json'))
  const cli = path.join(playwright_dir, 'cli.js')
  console.error('[mesh2motion] No Chrome or Edge found: downloading Playwright Chromium (one time only)…')

  await new Promise<void>((resolve, reject) => {
    // stdout belongs to the MCP protocol, so the installer's output goes to stderr
    // --no-shell skips the separate headless shell: the session runs the full build headless
    const child = spawn(process.execPath, [cli, 'install', 'chromium', '--no-shell'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const output: string[] = []
    const forward = (chunk: Buffer): void => {
      process.stderr.write(chunk)
      output.push(chunk.toString())
      if (output.length > 50) output.shift()
    }
    child.stdout.on('data', forward)
    child.stderr.on('data', forward)
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      const last_lines = output.join('').trim().split('\n').slice(-3).join(' ')
      reject(new Error(`Downloading Chromium failed (exit code ${code}): ${last_lines}`))
    })
  })

  if (!bundled_chromium_installed()) {
    throw new Error(`Chromium download finished but ${chromium.executablePath()} is missing`)
  }
  console.error('[mesh2motion] Chromium downloaded')
}
