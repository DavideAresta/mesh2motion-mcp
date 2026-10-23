#!/usr/bin/env node
// Fetches the Mesh2Motion web app, injects the MCP bridge page and builds it.
//
// Usage: node scripts/setup-app.mjs [--update] [--skip-install] [--skip-browser]
//
// Environment:
//   M2M_APP_DIR   where the app lives (default: ./vendor/mesh2motion-app)
//   M2M_APP_REPO  git URL to clone (default: the official GitHub repository)
//   M2M_APP_REF   branch, tag or commit to check out (default: the default branch)
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP_DIR = path.resolve(process.env.M2M_APP_DIR ?? path.join(ROOT, 'vendor', 'mesh2motion-app'))
const REPO = process.env.M2M_APP_REPO ?? 'https://github.com/Mesh2Motion/mesh2motion-app.git'
const REF = process.env.M2M_APP_REF
const args = new Set(process.argv.slice(2))
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run (command, command_args, cwd = ROOT, extra_env = {}) {
  console.log(`$ ${command} ${command_args.join(' ')}  (in ${path.relative(ROOT, cwd) || '.'})`)
  execFileSync(command, command_args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...extra_env },
    shell: process.platform === 'win32'
  })
}

function git_output (git_args) {
  return execFileSync('git', ['-C', APP_DIR, ...git_args], { encoding: 'utf8' }).trim()
}

// 1. source
if (!fs.existsSync(path.join(APP_DIR, 'package.json'))) {
  fs.mkdirSync(path.dirname(APP_DIR), { recursive: true })
  if (REF === undefined) {
    run('git', ['clone', '--depth', '1', REPO, APP_DIR])
  } else {
    run('git', ['clone', REPO, APP_DIR])
    run('git', ['-C', APP_DIR, 'checkout', REF])
  }
} else if (args.has('--update')) {
  if (REF !== undefined) {
    run('git', ['-C', APP_DIR, 'fetch', '--all', '--tags'])
    run('git', ['-C', APP_DIR, 'checkout', REF])
  } else {
    run('git', ['-C', APP_DIR, 'pull', '--ff-only'])
  }
}

let commit = 'unknown'
try {
  commit = git_output(['rev-parse', 'HEAD'])
} catch {
  // not a git checkout (e.g. M2M_APP_DIR points at a downloaded archive)
}

// 2. dependencies
const has_modules = fs.existsSync(path.join(APP_DIR, 'node_modules', 'vite'))
if (!(args.has('--skip-install') && has_modules)) {
  const has_lock = fs.existsSync(path.join(APP_DIR, 'package-lock.json'))
  run(NPM, [has_lock ? 'ci' : 'install', '--no-audit', '--no-fund'], APP_DIR)
}

// 3. bridge page: create.html with the bridge script instead of the normal bootstrap
const create_html = fs.readFileSync(path.join(APP_DIR, 'src', 'create.html'), 'utf8')
const bootstrap_pattern = /(<script[^>]+src=["'])\.\/CustomModelUploadBootstrap\.ts(["'])/
if (!bootstrap_pattern.test(create_html)) {
  throw new Error('src/create.html no longer loads ./CustomModelUploadBootstrap.ts; the bridge page needs updating')
}
fs.writeFileSync(
  path.join(APP_DIR, 'src', 'mcp-bridge.html'),
  create_html.replace(bootstrap_pattern, '$1./mcp-bridge/McpBridge.ts$2')
)
fs.mkdirSync(path.join(APP_DIR, 'src', 'mcp-bridge'), { recursive: true })
for (const file of fs.readdirSync(path.join(ROOT, 'bridge')).filter(name => name.endsWith('.ts'))) {
  fs.copyFileSync(path.join(ROOT, 'bridge', file), path.join(APP_DIR, 'src', 'mcp-bridge', file))
}
fs.copyFileSync(path.join(ROOT, 'bridge', 'mcp.vite.config.mjs'), path.join(APP_DIR, 'mcp.vite.config.mjs'))

// 4. build
run(process.execPath, [path.join(APP_DIR, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'mcp.vite.config.mjs'], APP_DIR, {
  M2M_APP_COMMIT: commit
})

const dist_dir = path.join(APP_DIR, 'dist-mcp')
if (!fs.existsSync(path.join(dist_dir, 'mcp-bridge.html'))) {
  throw new Error(`Build finished but ${dist_dir}/mcp-bridge.html is missing`)
}
fs.writeFileSync(path.join(dist_dir, 'm2m-build.json'), JSON.stringify({
  app_commit: commit,
  built_at: new Date().toISOString()
}, null, 2))

// 5. browser: Playwright's Chromium, unless a system Chrome can be used instead
if (!args.has('--skip-browser')) {
  const { chromium } = await import('playwright')
  const bundled = chromium.executablePath()
  let system_chrome = false
  if (!fs.existsSync(bundled)) {
    try {
      const browser = await chromium.launch({ channel: 'chrome', headless: true })
      await browser.close()
      system_chrome = true
    } catch {
      // no usable system Chrome
    }
  }

  if (fs.existsSync(bundled)) {
    console.log(`Playwright Chromium found: ${bundled}`)
  } else if (system_chrome) {
    console.log('Playwright Chromium not installed; the server will use the system Google Chrome')
  } else {
    // the server runs the full Chromium build headless, so the separate headless shell isn't needed
    run(process.execPath, [path.join(ROOT, 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium', '--no-shell'])
  }
}

console.log(`\nMesh2Motion app ready (commit ${commit.slice(0, 9)}) in ${dist_dir}`)
