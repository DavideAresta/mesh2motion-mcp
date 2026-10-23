import fs from 'node:fs'
import path from 'node:path'
import { chromium, type Browser, type BrowserContext, type Download, type Page } from 'playwright'
import { AUTO_INSTALL_BROWSER, BRIDGE_PAGE, BROWSER_CHANNEL, DIST_DIR, HEADLESS, VIEWPORT } from './config.js'
import { bundled_chromium_installed, find_system_browser, install_bundled_chromium } from './browser-install.js'
import { StaticServer } from './static-server.js'

// SwiftShader keeps WebGL working on machines without a usable GPU (CI, SSH, containers)
const BROWSER_ARGS = ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl']

const MAX_LOG_LINES = 40

/** Strips Playwright's wrapper text and the browser stack from an evaluate() error. */
export function clean_error (error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const first = raw.split('\n').find(line => line.trim() !== '') ?? raw
  return first
    .replace(/^page\.(evaluate|waitForFunction|goto|waitForEvent):\s*/, '')
    .replace(/^Error:\s*/, '')
    .trim()
}

/**
 * One headless browser tab running the Mesh2Motion bridge page.
 * Tool calls are serialized because the app is a single stateful scene.
 */
export class Mesh2MotionSession {
  private readonly server = new StaticServer(DIST_DIR)
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page: Page | null = null
  private starting: Promise<Page> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private readonly logs: Array<{ seq: number, line: string }> = []
  private log_seq = 0
  private browser_description = ''

  /** Run `task` after every previously queued task has finished, with the app's render loop running. */
  async exclusive<T> (task: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => await this.with_render_loop(task)
    const result = this.queue.then(run, run)
    this.queue = result.catch(() => undefined)
    return await result
  }

  // The app redraws its scene on every animation frame. Headless that only burns
  // CPU (several cores with SwiftShader), so the loop runs while a tool works and
  // pauses in between. A visible window keeps it running so it stays interactive.
  private async with_render_loop<T> (task: () => Promise<T>): Promise<T> {
    await this.set_render_loop(true)
    try {
      return await task()
    } finally {
      await this.set_render_loop(false)
    }
  }

  private async set_render_loop (running: boolean): Promise<void> {
    if (!HEADLESS || !this.is_running) return
    // only saves CPU: a page that is gone or reloading must not fail the tool
    await this.call('set_render_loop', { running }).catch(() => undefined)
  }

  get is_running (): boolean {
    return this.page !== null && !this.page.isClosed()
  }

  get browser_info (): string {
    return this.browser_description
  }

  /** Position in the browser log, to later ask for what was logged after it. */
  log_mark (): number {
    return this.log_seq
  }

  logs_since (mark: number, count = 8): string[] {
    return this.logs.filter(entry => entry.seq > mark).slice(-count).map(entry => entry.line)
  }

  private log (line: string): void {
    this.log_seq++
    this.logs.push({ seq: this.log_seq, line: line.length > 500 ? line.slice(0, 500) + '…' : line })
    if (this.logs.length > MAX_LOG_LINES) this.logs.shift()
  }

  async get_page (): Promise<Page> {
    if (this.page !== null && !this.page.isClosed()) return this.page
    if (this.starting === null) {
      this.starting = this.start().finally(() => { this.starting = null })
    }
    return await this.starting
  }

  // Playwright's Chromium is the fallback we can download ourselves; a forced chrome/msedge is used as is
  private get may_install_chromium (): boolean {
    return AUTO_INSTALL_BROWSER && (BROWSER_CHANNEL === undefined || BROWSER_CHANNEL === 'chromium')
  }

  /**
   * Called at server start: when no browser is installed, start downloading
   * Chromium right away so the first tool call doesn't wait for the whole download.
   */
  prepare_browser (): void {
    if (!this.may_install_chromium || bundled_chromium_installed()) return
    if (BROWSER_CHANNEL === undefined && find_system_browser() !== undefined) return
    install_bundled_chromium().catch((error: unknown) => {
      console.error(`[mesh2motion] ${clean_error(error)}`)
    })
  }

  private async launch_browser (): Promise<Browser> {
    // channel "chromium" runs the full Chromium build in the new headless mode, so a
    // single download (installed with --no-shell) covers headless and visible windows
    const bundled = { label: 'Playwright Chromium', channel: 'chromium' }
    const attempts: Array<{ label: string, channel?: string }> = []
    if (BROWSER_CHANNEL === 'chromium') {
      attempts.push(bundled)
    } else if (BROWSER_CHANNEL !== undefined) {
      attempts.push({ label: `channel ${BROWSER_CHANNEL}`, channel: BROWSER_CHANNEL })
    } else {
      if (bundled_chromium_installed()) attempts.push(bundled)
      attempts.push({ label: 'Google Chrome', channel: 'chrome' }, { label: 'Microsoft Edge', channel: 'msedge' })
    }

    const failures: string[] = []
    const try_launch = async (attempt: { label: string, channel?: string }): Promise<Browser | null> => {
      try {
        const browser = await chromium.launch({ headless: HEADLESS, channel: attempt.channel, args: BROWSER_ARGS })
        this.browser_description = `${attempt.label} ${browser.version()}`
        return browser
      } catch (error) {
        failures.push(`${attempt.label}: ${clean_error(error)}`)
        return null
      }
    }

    for (const attempt of attempts) {
      const browser = await try_launch(attempt)
      if (browser !== null) return browser
    }

    if (this.may_install_chromium && !bundled_chromium_installed()) {
      try {
        await install_bundled_chromium()
        const browser = await try_launch(bundled)
        if (browser !== null) return browser
      } catch (error) {
        failures.push(clean_error(error))
      }
    }

    const hints = [
      'Install Google Chrome, or run "npx playwright install chromium" in the mesh2motion-mcp folder.',
      process.platform === 'linux' ? 'On a minimal Linux system Chromium may also need its libraries: "sudo npx playwright install-deps chromium".' : ''
    ].filter(hint => hint !== '')
    throw new Error(`Could not start a browser.\n${failures.join('\n')}\n${hints.join('\n')}`)
  }

  private async start (): Promise<Page> {
    if (!fs.existsSync(path.join(DIST_DIR, BRIDGE_PAGE))) {
      throw new Error(`The Mesh2Motion app is not built yet (${DIST_DIR} is missing). Run "npm run setup" in the mesh2motion-mcp folder.`)
    }

    const base_url = await this.server.start()

    if (this.browser === null || !this.browser.isConnected()) {
      this.browser = await this.launch_browser()
      this.browser.on('disconnected', () => {
        this.browser = null
        this.context = null
        this.page = null
      })
    }

    await this.context?.close().catch(() => undefined)
    this.context = await this.browser.newContext({ viewport: VIEWPORT, acceptDownloads: true })
    const page = await this.context.newPage()

    page.on('console', (message) => {
      if (message.type() === 'error') this.log(`[console.error] ${message.text()}`)
    })
    page.on('pageerror', (error) => { this.log(`[page error] ${error.message}`) })
    page.on('dialog', (dialog) => {
      this.log(`[browser dialog] ${dialog.message()}`)
      void dialog.dismiss().catch(() => undefined)
    })

    await this.open_bridge(page, base_url)
    this.page = page
    return page
  }

  private async open_bridge (page: Page, base_url: string): Promise<void> {
    await page.goto(`${base_url}/${BRIDGE_PAGE}`, { waitUntil: 'load', timeout: 60000 })
    await page.waitForFunction(() => window.m2m_ready === true, undefined, { timeout: 60000 })

    const webgl = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2')
      if (gl === null) return null
      const info = gl.getExtension('WEBGL_debug_renderer_info')
      return info !== null ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown renderer'
    })
    if (webgl === null) {
      throw new Error('WebGL 2 is not available in the browser; Mesh2Motion needs it to render')
    }
    if (!this.browser_description.includes('WebGL')) {
      this.browser_description += ` (WebGL: ${webgl})`
    }
  }

  /** Fresh page: the app starts again at the "load model" step. */
  async reload (): Promise<void> {
    const page = await this.get_page()
    await this.open_bridge(page, this.server.url)
  }

  /** Calls a function of the bridge API (window.m2m) inside the page. */
  async call<T = Record<string, unknown>> (method: string, args: unknown = {}): Promise<T> {
    const page = await this.get_page()
    try {
      return await page.evaluate(
        async ([name, payload]) => await (window.m2m as any)[name](payload),
        [method, args] as const
      ) as T
    } catch (error) {
      throw new Error(clean_error(error))
    }
  }

  /** Runs `trigger` and saves the file the page downloads while it runs. */
  async capture_download (trigger: () => Promise<unknown>, timeout_ms: number): Promise<{ download: Download, result: unknown }> {
    const page = await this.get_page()
    const download_promise = page.waitForEvent('download', { timeout: timeout_ms })
    download_promise.catch(() => undefined)
    const result = await trigger()
    const download = await download_promise
    return { download, result }
  }

  async close (): Promise<void> {
    await this.browser?.close().catch(() => undefined)
    this.browser = null
    this.context = null
    this.page = null
    await this.server.stop()
  }
}

declare global {
  interface Window { m2m: unknown, m2m_ready: boolean }
}
