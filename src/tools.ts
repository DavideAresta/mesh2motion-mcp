import fs from 'node:fs'
import path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { reweight_with_blender } from './blender.js'
import { DIST_DIR, OUTPUT_DIR, resolve_input_path, resolve_output_path } from './config.js'
import { type Mesh2MotionSession } from './session.js'

const SKELETON_TYPES = ['human', 'fox', 'bird', 'dragon', 'kaiju', 'spider', 'snake', 'fish', 'horse'] as const
const HAND_TYPES = ['all-fingers', 'thumb-and-index', 'simplified-hand', 'single-bone'] as const
const VIEWS = ['front', 'back', 'left', 'right', 'top', 'bottom', 'perspective'] as const
const BUILTIN_MODELS: Record<string, string> = {
  human: 'models/model-human.glb',
  fox: 'models/model-fox.glb',
  bird: 'models/model-bird.glb',
  dragon: 'models/model-dragon.glb',
  kaiju: 'models/model-kaiju.glb',
  spider: 'models/model-spider.glb',
  snake: 'models/model-snake.glb',
  fish: 'models/model-shark.glb',
  horse: 'models/model-horse.glb',
  'human-a-pose': 'test-files/bone-correction-tests/human-a-pose.glb'
}
const MODEL_EXTENSIONS = new Set(['.glb', '.fbx', '.zip'])

const vec3 = z.tuple([z.number(), z.number(), z.number()])

type Counters = Record<'model_loaded' | 'skeleton_loaded' | 'animations_loaded' | 'animations_failed', number>

function json_result (value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

function decode_data_url (data_url: string): string {
  const comma = data_url.indexOf(',')
  return comma === -1 ? data_url : data_url.slice(comma + 1)
}

function save_png (base64: string, save_path: string | undefined): string | undefined {
  if (save_path === undefined) return undefined
  let output = resolve_output_path(save_path)
  if (path.extname(output).toLowerCase() !== '.png') output += '.png'
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, Buffer.from(base64, 'base64'))
  return output
}

function image_result (image_data_url: string, meta: Record<string, unknown>, save_path?: string): CallToolResult {
  const base64 = decode_data_url(image_data_url)
  const saved = save_png(base64, save_path)
  return {
    content: [
      { type: 'image', data: base64, mimeType: 'image/png' },
      { type: 'text', text: JSON.stringify(saved !== undefined ? { ...meta, saved_to: saved } : meta, null, 2) }
    ]
  }
}

export const SERVER_INSTRUCTIONS = `Mesh2Motion turns a static 3D model into an animated, rigged character (like Mixamo, but open source and for many creature types). This server drives the real Mesh2Motion web app in a headless browser.

Pipeline (each step unlocks the next):
1. load_model (GLB, FBX or ZIP with glTF; or a builtin sample) -> step "load_skeleton".
2. Optional transform_model (rotate so the character stands up on +Y and faces +Z, align_to_floor, center_xz, rescale).
3. select_skeleton (type + scale, "auto" is a good first guess), check with screenshot, then confirm_skeleton -> step "edit_skeleton".
4. Place the joints inside the mesh. For a human in T-pose, auto_place_joints fits them all from the mesh shape. Otherwise, or to correct it: get_bones, screenshot (front + left views show labelled joints and a coordinate grid), analyze_model (vertex slices), then set_bones with world positions. Left/right edits mirror automatically. Optional set_skinning_options and preview="weights" to inspect the weights.
5. bind_skin computes the skin weights and loads the animation library -> step "animations".
6. list_animations, play_animation, animation_sheet (frame grid to judge the result), set_animation_options, set_props, import_animations.
7. export writes a GLB or FBX with the chosen animations. go_back_to_step edit_skeleton lets you fix joints and bind again.
8. Optional, when Blender is installed: reweight_with_blender on the exported GLB replaces Mesh2Motion's weights with Blender's automatic (bone heat) weights. Mesh2Motion's weights are hard-edged on hands and feet, so curled fingers and loose clothing can tear; check close-ups of hands, wrists and clothing in the animations before deciding.

Coordinates are world space: Y is up, the character faces +Z, the character's own left side is +X. Units match the model (the app rescales extreme models on import). Relative output paths are written under ${OUTPUT_DIR}.`

export function register_tools (server: McpServer, session: Mesh2MotionSession): void {
  // Every tool runs exclusively against the single browser page, and errors are
  // returned as tool errors with the latest browser console lines attached.
  const tool = <Shape extends z.ZodRawShape>(
    name: string,
    config: { title: string, description: string, input: Shape, read_only?: boolean, destructive?: boolean },
    handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<CallToolResult>
  ): void => {
    server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema: config.input,
        annotations: {
          readOnlyHint: config.read_only ?? false,
          destructiveHint: config.destructive ?? false,
          openWorldHint: false
        }
      },
      (async (args: z.infer<z.ZodObject<Shape>>): Promise<CallToolResult> => {
        const mark = session.log_mark()
        try {
          return await session.exclusive(async () => await handler(args))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const logs = session.logs_since(mark, 6)
          const text = logs.length > 0 ? `${message}\n\nBrowser errors during this call:\n${logs.join('\n')}` : message
          return { isError: true, content: [{ type: 'text', text }] }
        }
      }) as any
    )
  }

  const wait_for = async (counter: keyof Counters, before: Counters, label: string, timeout_ms: number): Promise<void> => {
    await session.call('wait_for_counter', { counter, above: before[counter], label, timeout_ms })
  }

  tool('status', {
    title: 'Session status',
    description: 'Current pipeline step, loaded model, skeleton, animation state and recent app dialogs.',
    input: {},
    read_only: true
  }, async () => {
    if (!session.is_running) {
      return json_result({ browser: 'not started (starts on the first tool that needs it)', app_build: DIST_DIR })
    }
    const status = await session.call('status')
    return json_result({ ...status, browser: session.browser_info })
  })

  tool('list_catalog', {
    title: 'List rigs, sample models, props and export options',
    description: 'Skeleton types with their animation libraries, builtin sample models, hand skeleton options, prop ids for set_props and the export formats/presets.',
    input: {},
    read_only: true
  }, async () => {
    const catalog = await session.call('catalog')
    let build: unknown = null
    try {
      build = JSON.parse(fs.readFileSync(path.join(DIST_DIR, 'm2m-build.json'), 'utf8'))
    } catch {
      // build info is optional
    }
    return json_result({ ...catalog, builtin_model_ids: Object.keys(BUILTIN_MODELS), app_build: build })
  })

  tool('load_model', {
    title: 'Load a 3D model',
    description: 'Starts a fresh session and imports a model. Give either `path` (a .glb, .fbx, or .zip holding a .gltf with its .bin/textures) or `builtin` (a sample model id from list_catalog). Mesh2Motion strips existing rigs/animations and keeps only the meshes. Afterwards the app is at the "load_skeleton" step.',
    input: {
      path: z.string().optional().describe('Model file on this machine (absolute, ~/..., or relative to the server working directory)'),
      builtin: z.enum(Object.keys(BUILTIN_MODELS) as [string, ...string[]]).optional().describe('Sample model shipped with Mesh2Motion'),
      timeout_s: z.number().positive().max(900).optional().describe('Seconds to wait for the import (default 120)')
    }
  }, async (args) => {
    if ((args.path === undefined) === (args.builtin === undefined)) {
      throw new Error('Give exactly one of `path` or `builtin`')
    }
    const timeout_ms = (args.timeout_s ?? 120) * 1000
    await session.reload()

    if (args.builtin !== undefined) {
      const model = await session.call('load_builtin_model', { file: BUILTIN_MODELS[args.builtin], timeout_ms })
      return json_result({ loaded: args.builtin, step: 'load_skeleton', model })
    }

    const file_path = resolve_input_path(args.path!)
    if (!fs.existsSync(file_path)) throw new Error(`File not found: ${file_path}`)
    const extension = path.extname(file_path).toLowerCase()
    if (extension === '.gltf') {
      throw new Error('A .gltf file needs its .bin and textures: put them in one .zip (or convert to .glb) and load that')
    }
    if (!MODEL_EXTENSIONS.has(extension)) {
      throw new Error(`Unsupported format "${extension}". Mesh2Motion imports .glb, .fbx and .zip (glTF + bin + textures)`)
    }

    const page = await session.get_page()
    const before = await session.call<Counters>('get_counters')
    await page.setInputFiles('#model-upload', file_path)
    await wait_for('model_loaded', before, 'model load', timeout_ms)
    const status = await session.call('status')
    return json_result({ loaded: file_path, step: status.step, model: status.model })
  })

  tool('transform_model', {
    title: 'Orient, scale and place the model',
    description: 'Bakes transforms into the mesh before rigging (step "load_skeleton"). Operations run in this order: reset, scale, rotate, target_height, center_xz, align_to_floor, translate. The skeleton expects the character standing on y=0, facing +Z, centered on X/Z.',
    input: {
      reset: z.boolean().optional().describe('Undo all previous moves/rotations (back to the imported vertex positions)'),
      scale: z.number().positive().optional().describe('Uniform scale factor'),
      rotate: z.array(z.object({ axis: z.enum(['x', 'y', 'z']), degrees: z.number() })).optional().describe('Rotations applied in order, e.g. [{"axis":"x","degrees":-90}] for a Z-up model'),
      target_height: z.number().positive().optional().describe('Scale uniformly so the model is this tall on Y'),
      center_xz: z.boolean().optional().describe('Center the model on the X/Z origin'),
      align_to_floor: z.boolean().optional().describe('Move the model so its lowest point sits on y=0'),
      translate: vec3.optional().describe('Move by [dx, dy, dz]')
    }
  }, async (args) => json_result(await session.call('transform_model', args)))

  tool('analyze_model', {
    title: 'Analyze the mesh shape',
    description: 'Slices the model along Y (or Z for long creatures) and reports, per slice, the separate solid spans along X ("islands") and the depth range. Useful to find joint heights without looking at images: where the legs split (crotch), shoulder/arm span in T-pose, neck narrowing, etc.',
    input: {
      slices: z.number().int().min(4).max(80).optional().describe('Number of slices (default 24)'),
      axis: z.enum(['y', 'z']).optional().describe('Slice along height (y, default) or length (z)')
    },
    read_only: true
  }, async (args) => json_result(await session.call('analyze_model', args)))

  tool('select_skeleton', {
    title: 'Choose the skeleton template',
    description: 'Picks the rig type and previews it over the model (step "load_skeleton"). Call it again to try another scale. scale "auto" matches the model size to the rig\'s reference model. Follow with a screenshot to check the fit, then confirm_skeleton.',
    input: {
      type: z.enum(SKELETON_TYPES).describe('Rig type'),
      hand_type: z.enum(HAND_TYPES).optional().describe('Human only: finger setup (default all-fingers)'),
      scale: z.union([z.number().positive().max(100), z.literal('auto')]).optional().describe('Skeleton scale: a factor (1 = rig size) or "auto"')
    }
  }, async (args) => json_result(await session.call('select_skeleton', args)))

  tool('confirm_skeleton', {
    title: 'Confirm the skeleton and start placing joints',
    description: 'Loads the selected rig at the chosen scale and moves to the "edit_skeleton" step. Returns the bones with world positions.',
    input: {}
  }, async () => json_result(await session.call('confirm_skeleton', {})))

  tool('get_bones', {
    title: 'List the skeleton bones',
    description: 'Bones with parent, world position (the joint location) and mirror counterpart. Works on the preview (load_skeleton), the editable skeleton (edit_skeleton) and the animated skeleton at its current pose (animations).',
    input: {
      include_details: z.boolean().optional().describe('Include finger and leaf/tip bones (default true)')
    },
    read_only: true
  }, async (args) => json_result(await session.call('get_bones', args)))

  const marker = z.array(z.number()).min(2).max(3)
  tool('auto_place_joints', {
    title: 'Place the human joints automatically',
    description: 'Human rig, step "edit_skeleton": fits every joint to the mesh from its cross-sections (crotch, knees, ankles, armpits, elbows, wrists, neck); spine and fingers keep the rig\'s spacing, scaled to the body and hand. Needs a T-pose standing on y=0 and facing +Z (transform_model align_to_floor/center_xz first); refuses other poses. Optional markers override detected landmarks. Returns the main joints, which landmarks were detected or estimated (sources, confidence) and notes; it also puts the head correction plane under the chin. Check with screenshot and fix single joints with set_bones.',
    input: {
      markers: z.object({
        chin: marker.optional(),
        groin: marker.optional(),
        left_wrist: marker.optional(),
        right_wrist: marker.optional(),
        left_elbow: marker.optional(),
        right_elbow: marker.optional(),
        left_knee: marker.optional(),
        right_knee: marker.optional()
      }).optional().describe('World points read from a front view: [x, y], or [x, y, z] to set the depth too. "left" is the character\'s left (+X)'),
      symmetric: z.boolean().optional().describe('Average both sides into a mirror-symmetric skeleton (default true); false keeps each side as measured')
    }
  }, async (args) => json_result(await session.call('auto_place_joints', args)))

  tool('set_bones', {
    title: 'Move or rotate joints',
    description: 'Places joints during "edit_skeleton". For each bone give `position` (absolute world position of the joint), `offset` (world delta) and/or `rotation_deg` (local Euler XYZ in degrees). By default an edit on a left/right bone is mirrored across X onto its counterpart, and children move with their parent; bones are applied parent-first so absolute child positions are honored. Undo with edit_history.',
    input: {
      bones: z.array(z.object({
        name: z.string(),
        position: vec3.optional(),
        offset: vec3.optional(),
        rotation_deg: vec3.optional()
      })).min(1),
      mirror: z.boolean().optional().describe('Mirror left/right edits onto the other side (default true)'),
      keep_children_in_place: z.boolean().optional().describe('Keep bones that were not listed at their current world position (default false)')
    }
  }, async (args) => json_result(await session.call('set_bone_transforms', args)))

  tool('edit_history', {
    title: 'Undo / redo joint edits',
    description: 'Undo or redo the last set_bones call while in "edit_skeleton".',
    input: { action: z.enum(['undo', 'redo']) }
  }, async (args) => json_result(await session.call('edit_history', args)))

  tool('set_skinning_options', {
    title: 'Skinning options and weight preview',
    description: 'Options used by bind_skin (human rig only: head weight correction plane and arm plane correction) and the edit preview mode. preview "weights" colors the mesh by bone influence so a screenshot shows how the current joints would skin.',
    input: {
      head_weight_correction: z.boolean().optional().describe('Human: vertices above the plane are weighted to the head only'),
      head_correction_height: z.number().optional().describe('Human: Y height of the head correction plane'),
      arm_plane_correction: z.boolean().optional().describe('Human: stop arm weights bleeding into the torso'),
      arm_plane_offset: z.number().min(-0.5).max(0.5).optional().describe('Human: X offset of the arm plane from the shoulder joint'),
      preview: z.enum(['textured', 'weights']).optional()
    }
  }, async (args) => json_result(await session.call('set_skinning_options', args)))

  tool('bind_skin', {
    title: 'Bind the mesh to the skeleton',
    description: 'Computes the skin weights from the current joints, creates the skinned mesh and loads the animation library for the rig. Moves to the "animations" step.',
    input: {
      timeout_s: z.number().positive().max(1800).optional().describe('Seconds to wait for skinning + animation library (default 180)')
    }
  }, async (args) => json_result(await session.call('bind_skin', { timeout_ms: (args.timeout_s ?? 180) * 1000 })))

  tool('go_back_to_step', {
    title: 'Go back in the pipeline',
    description: '"edit_skeleton" returns from the animations step to the joints (they keep their positions; bind_skin again afterwards). "load_skeleton" goes back to choosing the rig (joint edits are lost). To start over with another model just call load_model.',
    input: { step: z.enum(['edit_skeleton', 'load_skeleton']) },
    destructive: true
  }, async (args) => json_result(await session.call('go_back_to_step', args)))

  tool('list_animations', {
    title: 'List available animations',
    description: 'Animations available for the bound character (step "animations"), with durations. `filter` keeps names containing every word (e.g. "walk", "sword attack").',
    input: {
      filter: z.string().optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(1000).optional().describe('Default 200')
    },
    read_only: true
  }, async (args) => json_result(await session.call('list_animations', args)))

  tool('play_animation', {
    title: 'Play or pose an animation',
    description: 'Plays an animation on the character. With `time` (seconds) or paused=true the pose is frozen there, so a following screenshot shows that frame.',
    input: {
      name: z.string(),
      time: z.number().min(0).optional(),
      paused: z.boolean().optional()
    }
  }, async (args) => json_result(await session.call('play_animation', args)))

  tool('set_animation_options', {
    title: 'Animation adjustments',
    description: 'mirror flips every animation left/right. arm_extension (human only, the app\'s A-pose correction) raises or lowers the arms in all animations, useful when the model was modelled in an A-pose; 0 = unchanged.',
    input: {
      mirror: z.boolean().optional(),
      arm_extension: z.number().min(-100).max(100).optional()
    }
  }, async (args) => json_result(await session.call('set_animation_options', args)))

  tool('set_props', {
    title: 'Attach weapons/props to the hands',
    description: 'Attaches a prop to the left and/or right hand (human and kaiju rigs). Props follow the animations and are included in full exports. Use "none" to remove; ids come from list_catalog.',
    input: {
      left: z.string().optional(),
      right: z.string().optional()
    }
  }, async (args) => json_result(await session.call('set_props', args)))

  tool('import_animations', {
    title: 'Import custom animations',
    description: 'Adds animations from .glb files made for the same Mesh2Motion rig (bone names must match). Step "animations".',
    input: {
      paths: z.array(z.string()).min(1),
      timeout_s: z.number().positive().max(600).optional()
    }
  }, async (args) => {
    const files = args.paths.map(resolve_input_path)
    for (const file of files) {
      if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`)
      if (path.extname(file).toLowerCase() !== '.glb') throw new Error(`Only .glb animation files are supported: ${file}`)
    }
    const status = await session.call('status')
    if (status.step !== 'animations') throw new Error('Custom animations can be imported in the "animations" step (after bind_skin)')

    const page = await session.get_page()
    const before = await session.call<Counters>('get_counters')
    await page.setInputFiles('#import-animations-input', files)
    await wait_for('animations_loaded', before, 'animation import', (args.timeout_s ?? 120) * 1000)
    const after = await session.call('status')
    return json_result({
      imported_files: files,
      animation_count_before: status.animation_count,
      animation_count: after.animation_count,
      custom_animations: (await session.call<{ animations: Array<{ name: string, source: string }> }>('list_animations', { limit: 1000 }))
        .animations.filter(animation => animation.source === 'custom').map(animation => animation.name)
    })
  })

  tool('export', {
    title: 'Export the rigged, animated model',
    description: 'Writes a GLB or FBX with the skinned mesh (or only the skeleton) and the chosen animations. Each animation can be exported as is, mirrored, or both. Mesh2Motion needs at least one animation.',
    input: {
      output_path: z.string().describe(`Destination file; relative paths go under ${OUTPUT_DIR}. The extension is set from the format.`),
      animations: z.array(z.union([
        z.string(),
        z.object({ name: z.string(), mirror: z.enum(['none', 'mirrored', 'both']).optional() })
      ])).optional().describe('Animation names, or {name, mirror} objects'),
      all_animations: z.boolean().optional().describe('Export every available animation instead of a list'),
      format: z.enum(['glb', 'fbx']).optional().describe('Default glb'),
      fbx_preset: z.enum(['unreal', 'unity']).optional().describe('FBX axis/scale preset (default unreal)'),
      bone_naming: z.enum(['default', 'mixamo']).optional().describe('Human only: rename bones to Mixamo names'),
      contents: z.enum(['full', 'skeleton']).optional().describe('"skeleton" leaves out the mesh (default full)'),
      timeout_s: z.number().positive().max(1800).optional()
    }
  }, async (args) => {
    const format = args.format ?? 'glb'
    let animations: Array<{ name: string, mirror?: string }>
    if (args.all_animations === true) {
      const listed = await session.call<{ animations: Array<{ name: string }> }>('list_animations', { limit: 1000 })
      animations = listed.animations.map(animation => ({ name: animation.name }))
    } else {
      animations = (args.animations ?? []).map(entry => typeof entry === 'string' ? { name: entry } : entry)
    }
    if (animations.length === 0) throw new Error('Give `animations` or set all_animations=true')

    let output = resolve_output_path(args.output_path)
    if (path.extname(output).toLowerCase() !== `.${format}`) output += `.${format}`
    fs.mkdirSync(path.dirname(output), { recursive: true })

    const { download, result } = await session.capture_download(async () => await session.call('export_model', {
      animations,
      format,
      fbx_preset: args.fbx_preset,
      bone_naming: args.bone_naming,
      contents: args.contents,
      filename: path.basename(output, path.extname(output))
    }), (args.timeout_s ?? 300) * 1000)
    await download.saveAs(output)

    return json_result({
      saved_to: output,
      size_bytes: fs.statSync(output).size,
      format,
      ...(result as Record<string, unknown>)
    })
  })

  tool('reweight_with_blender', {
    title: 'Recompute skin weights with Blender',
    description: 'Replaces the skin weights of a GLB written by `export` with Blender\'s automatic weights (bone heat diffusion). Mesh2Motion gives each vertex to its closest bone and blends only a few rings of vertices at each boundary, and never on hands and feet, so curled fingers and loose clothing can tear; bone heat blends smoothly through the volume. Every bone deforms except the tip markers and an unweighted root; the skeleton, rest pose and animations are kept as exported. Runs Blender in the background (M2M_BLENDER or `blender` on PATH) and does not change the live session.',
    input: {
      input_path: z.string().describe(`GLB written by export with contents "full"; relative paths are read from ${OUTPUT_DIR}`),
      output_path: z.string().optional().describe('Destination GLB (default: next to the input, named <input>-blender.glb)'),
      smooth: z.number().int().min(0).max(10).optional().describe('Weight smoothing passes after the heat solve (default 2)'),
      max_influences: z.number().int().min(1).max(8).optional().describe('Bones per vertex in the result (default 4)'),
      timeout_s: z.number().positive().max(1800).optional().describe('Default 300')
    }
  }, async (args) => {
    const input = resolve_output_path(args.input_path)
    if (!fs.existsSync(input)) throw new Error(`File not found: ${input}`)
    if (path.extname(input).toLowerCase() !== '.glb') {
      throw new Error('Only GLB files can be reweighted: export with format "glb", then convert the result if you need FBX')
    }
    let output = args.output_path !== undefined
      ? resolve_output_path(args.output_path)
      : path.join(path.dirname(input), `${path.basename(input, path.extname(input))}-blender.glb`)
    if (path.extname(output).toLowerCase() !== '.glb') output += '.glb'
    if (output === input) throw new Error('output_path must differ from input_path')
    fs.mkdirSync(path.dirname(output), { recursive: true })

    const summary = await reweight_with_blender(input, output, {
      smooth: args.smooth ?? 2,
      max_influences: args.max_influences ?? 4,
      timeout_ms: (args.timeout_s ?? 300) * 1000
    })
    return json_result({ saved_to: output, size_bytes: fs.statSync(output).size, ...summary })
  })

  tool('screenshot', {
    title: 'Render the scene',
    description: 'Renders the model from a fixed view. Orthographic views (front/back/left/right/top/bottom) draw a world-coordinate grid so joint positions can be read off the image; joints are drawn as dots with names (cyan = left side, orange = right, yellow = center). "left" looks at the character\'s left side (camera on +X).',
    input: {
      view: z.enum(VIEWS).optional().describe('Default front'),
      width: z.number().int().min(64).max(2048).optional().describe('Default 768'),
      height: z.number().int().min(64).max(2048).optional().describe('Default 768'),
      show_skeleton: z.boolean().optional().describe('Default: on while choosing/editing the skeleton, off in the animations step'),
      labels: z.enum(['none', 'main', 'all']).optional().describe('Joint labels; "main" skips fingers and tip bones (default main when the skeleton is shown)'),
      grid: z.boolean().optional().describe('Coordinate grid on orthographic views (default true)'),
      show_floor: z.boolean().optional().describe('Default true'),
      focus: z.enum(['auto', 'model', 'skeleton']).optional().describe('What to frame (default both)'),
      zoom: z.number().min(0.1).max(20).optional().describe('>1 zooms in on the center of the framed area'),
      background: z.string().optional().describe('CSS color, default #30343b'),
      save_path: z.string().optional().describe('Also save the PNG here')
    },
    read_only: true
  }, async (args) => {
    const { image, ...meta } = await session.call<{ image: string } & Record<string, unknown>>('capture', args)
    return image_result(image, meta, args.save_path)
  })

  tool('animation_sheet', {
    title: 'Render animation frames as a grid',
    description: 'Samples an animation at evenly spaced times and renders them into one image (contact sheet) with a fixed camera, to judge the motion and catch skinning problems. Step "animations".',
    input: {
      name: z.string(),
      frames: z.number().int().min(1).max(36).optional().describe('Default 8'),
      columns: z.number().int().min(1).max(36).optional().describe('Default min(frames, 4)'),
      view: z.enum(VIEWS).optional().describe('Default front'),
      cell_width: z.number().int().min(64).max(1024).optional().describe('Default 256'),
      cell_height: z.number().int().min(64).max(1024).optional().describe('Default 256'),
      show_skeleton: z.boolean().optional(),
      background: z.string().optional(),
      save_path: z.string().optional()
    },
    read_only: true
  }, async (args) => {
    const { image, ...meta } = await session.call<{ image: string } & Record<string, unknown>>('animation_sheet', args)
    return image_result(image, meta, args.save_path)
  })

  tool('reset', {
    title: 'Reset the session',
    description: 'Reloads the app; everything that was loaded is discarded.',
    input: {},
    destructive: true
  }, async () => {
    await session.reload()
    return json_result({ step: 'load_model', browser: session.browser_info })
  })
}
