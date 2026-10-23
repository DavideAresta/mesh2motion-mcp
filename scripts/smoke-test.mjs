#!/usr/bin/env node
// End-to-end check through a real MCP client: rigs the builtin human sample,
// renders a few images and exports GLB + FBX into output/smoke-test/.
//
// Usage: node scripts/smoke-test.mjs [--model path/to/model.glb] [--type human]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'output', 'smoke-test')
const argv = process.argv.slice(2)
const option = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1] }
const model_path = option('--model')
const rig_type = option('--type') ?? 'human'

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

const client = new Client({ name: 'mesh2motion-smoke-test', version: '0.1.0' })
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, 'dist', 'index.js')],
  stderr: 'inherit'
}))

let failures = 0
async function call (name, args = {}) {
  const started = Date.now()
  const result = await client.callTool({ name, arguments: args })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  const text = result.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
  const images = result.content.filter(part => part.type === 'image').length
  if (result.isError) {
    failures++
    console.log(`✗ ${name} (${seconds}s)\n${text}\n`)
    return null
  }
  console.log(`✓ ${name} (${seconds}s)${images > 0 ? ` [${images} image]` : ''}`)
  try { return JSON.parse(text) } catch { return text }
}

// Blender is optional: without it the step is skipped instead of failing the run
async function reweight (glb_path) {
  const result = await client.callTool({ name: 'reweight_with_blender', arguments: { input_path: glb_path } })
  const text = result.content.map(part => part.text).join('\n')
  if (result.isError && text.startsWith('Blender not found')) {
    console.log('- reweight_with_blender skipped (Blender not installed)')
    return
  }
  if (result.isError) {
    failures++
    console.log(`✗ reweight_with_blender\n${text}\n`)
    return
  }
  const summary = JSON.parse(text)
  console.log(`✓ reweight_with_blender (Blender ${summary.blender})`)
  console.log('  reweighted:', summary.saved_to, summary.deform_bones, 'deform bones,', summary.animations.length, 'clips')
}

const { tools } = await client.listTools()
console.log(`${tools.length} tools: ${tools.map(t => t.name).join(', ')}\n`)

await call('load_model', model_path !== undefined ? { path: model_path } : { builtin: rig_type })
await call('analyze_model', { slices: 12 })
const selected = await call('select_skeleton', { type: rig_type, scale: 'auto' })
console.log('  scale:', selected?.scale, 'hints:', selected?.hints)
await call('screenshot', { view: 'front', save_path: path.join(OUT, '01-preview-front.png') })
const confirmed = await call('confirm_skeleton')
console.log('  bones:', confirmed?.bone_count)

if (rig_type === 'human') {
  const placed = await call('auto_place_joints')
  console.log('  placed:', placed?.placed, 'confidence:', placed?.confidence, 'notes:', placed?.notes)
  await call('screenshot', { view: 'front', save_path: path.join(OUT, '02-auto-joints-front.png') })
}

const bones = await call('get_bones', { include_details: false })
const side_bone = bones?.bones.find(bone => bone.mirror !== undefined)
await call('screenshot', { view: 'front', save_path: path.join(OUT, '02-edit-front.png') })
await call('screenshot', { view: 'left', save_path: path.join(OUT, '03-edit-left.png') })

if (side_bone !== undefined) {
  const moved = await call('set_bones', { bones: [{ name: side_bone.name, offset: [0.02, 0, 0] }] })
  console.log('  moved:', JSON.stringify(moved?.updated), 'mirrored:', moved?.mirrored)
  await call('edit_history', { action: 'undo' })
}

await call('set_skinning_options', { preview: 'weights' })
await call('screenshot', { view: 'front', save_path: path.join(OUT, '04-weights.png') })
await call('set_skinning_options', { preview: 'textured' })

const bound = await call('bind_skin')
console.log('  animations:', bound?.animation_count)

const listed = await call('list_animations', { filter: 'walk', limit: 5 })
const all = await call('list_animations', { limit: 3 })
const first = listed?.animations[0]?.name ?? all?.animations[0]?.name
if (first !== undefined) {
  await call('play_animation', { name: first, time: 0.3 })
  await call('screenshot', { view: 'perspective', save_path: path.join(OUT, '05-pose.png') })
  await call('animation_sheet', { name: first, frames: 8, save_path: path.join(OUT, '06-sheet.png') })

  const names = [first, ...(all?.animations ?? []).map(a => a.name)].slice(0, 3)
  const glb = await call('export', { output_path: path.join(OUT, 'character'), animations: names, format: 'glb' })
  console.log('  glb:', glb?.saved_to, glb?.size_bytes, 'bytes,', glb?.clip_count, 'clips')
  if (glb !== null) await reweight(glb.saved_to)
  const fbx = await call('export', { output_path: path.join(OUT, 'character-unity'), animations: [{ name: first, mirror: 'both' }], format: 'fbx', fbx_preset: 'unity' })
  console.log('  fbx:', fbx?.saved_to, fbx?.size_bytes, 'bytes,', fbx?.clip_count, 'clips')
}

await call('go_back_to_step', { step: 'edit_skeleton' })
const status = await call('status')
console.log('  final step:', status?.step, '| browser:', status?.browser)

await client.close()
console.log(failures === 0 ? '\nAll steps passed' : `\n${failures} step(s) failed`)
process.exit(failures === 0 ? 0 : 1)
