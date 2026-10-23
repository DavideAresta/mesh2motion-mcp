import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { BLENDER_PATH, PROJECT_ROOT } from './config.js'

const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'blender_reweight.py')
const RESULT_PREFIX = 'M2M_RESULT '

function on_path (name: string): string | undefined {
  const names = process.platform === 'win32' ? [`${name}.exe`] : [name]
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const candidate of names) {
      const full = path.join(dir, candidate)
      if (dir !== '' && fs.existsSync(full)) return full
    }
  }
  return undefined
}

/** Newest "Blender x.y" install under Windows' default folder. */
function windows_install (): string | undefined {
  const root = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Blender Foundation')
  if (!fs.existsSync(root)) return undefined
  const versions = fs.readdirSync(root)
    .map(dir => path.join(root, dir, 'blender.exe'))
    .filter(file => fs.existsSync(file))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  return versions[0]
}

/** M2M_BLENDER, then `blender` on PATH, then the default install location of macOS and Windows. */
export function find_blender (): string | undefined {
  if (BLENDER_PATH !== undefined) return BLENDER_PATH
  const found = on_path('blender')
  if (found !== undefined) return found
  if (process.platform === 'darwin') {
    const app = '/Applications/Blender.app/Contents/MacOS/Blender'
    return fs.existsSync(app) ? app : undefined
  }
  return process.platform === 'win32' ? windows_install() : undefined
}

// Linux distribution builds of Blender (e.g. Ubuntu's) embed the system Python and locate
// its standard library through the python3 found on PATH, so a conda or pyenv python3
// earlier on PATH breaks Blender's add-ons. Official builds bundle their own Python and
// don't care about the order.
function blender_env (): NodeJS.ProcessEnv {
  if (process.platform !== 'linux') return process.env
  const system_dirs = ['/usr/bin', '/bin']
  const rest = (process.env.PATH ?? '').split(path.delimiter).filter(dir => dir !== '' && !system_dirs.includes(dir))
  return { ...process.env, PATH: [...system_dirs, ...rest].join(path.delimiter) }
}

function tail (text: string, lines: number): string {
  return text.split('\n').filter(line => line.trim() !== '').slice(-lines).join('\n')
}

export interface ReweightOptions {
  smooth: number
  max_influences: number
  timeout_ms: number
}

/** Runs scripts/blender_reweight.py on `input` and writes `output`; returns the script's summary. */
export async function reweight_with_blender (input: string, output: string, options: ReweightOptions): Promise<Record<string, unknown>> {
  const blender = find_blender()
  if (blender === undefined) {
    throw new Error('Blender not found. Install Blender (3.6 or newer) or set M2M_BLENDER to its executable.')
  }
  if (!fs.existsSync(blender)) throw new Error(`Blender not found at ${blender} (M2M_BLENDER)`)
  const args = [
    '-b', '--factory-startup', '--python-exit-code', '1', '--python', SCRIPT, '--',
    input, output, '--smooth', String(options.smooth), '--max-influences', String(options.max_influences)
  ]
  const { stdout, stderr } = await new Promise<{ stdout: string, stderr: string }>((resolve, reject) => {
    execFile(blender, args, { env: blender_env(), timeout: options.timeout_ms, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ stdout, stderr })
        return
      }
      const reason = error.killed === true ? `timed out after ${options.timeout_ms / 1000}s` : `exited with ${String(error.code)}`
      reject(new Error(`Blender ${reason} (${blender}).\n${tail(`${stdout}\n${stderr}`, 15)}`))
    })
  })

  const line = stdout.split('\n').find(entry => entry.startsWith(RESULT_PREFIX))
  if (line === undefined) {
    throw new Error(`Blender finished without a result (${blender}).\n${tail(`${stdout}\n${stderr}`, 15)}`)
  }
  // Blender reports bone heat failures as warnings; those vertices keep their Mesh2Motion weights.
  const warnings = `${stdout}\n${stderr}`.split('\n').filter(entry => /bone heat/i.test(entry)).map(entry => entry.trim())
  return { ...JSON.parse(line.slice(RESULT_PREFIX.length)), blender_path: blender, warnings }
}
