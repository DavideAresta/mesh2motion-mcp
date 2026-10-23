/**
 * MCP bridge page for Mesh2Motion.
 *
 * This file is copied into the Mesh2Motion source tree (src/mcp-bridge/) by
 * scripts/setup-app.mjs and bundled by the app's own Vite build, so it can
 * import the engine directly. It boots the same engine as create.html and
 * exposes a small promise-based API on `window.m2m` that the MCP server calls
 * through Playwright's page.evaluate().
 *
 * Everything returned from the API must be JSON serializable.
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { Mesh2MotionEngine } from '../Mesh2MotionEngine'
import { ProcessStep } from '../lib/enums/ProcessStep'
import { SkeletonType, HandSkeletonType } from '../lib/enums/SkeletonType'
import { ModelPreviewDisplay } from '../lib/enums/ModelPreviewDisplay'
import { RigConfig } from '../lib/RigConfig'
import { Utility } from '../lib/Utilities'
import { ModalDialog } from '../lib/ModalDialog'
import { ModelCleanupUtility } from '../lib/processes/load-model/ModelCleanupUtility'
import { ArmExtensionControl } from '../lib/processes/animations-listing/ArmExtensionControl'
import { PropCatalog } from '../lib/processes/animations-listing/props/PropCatalog'
import { PropType } from '../lib/processes/animations-listing/props/PropType'
import { fit_human_joints, type BodyMarkers } from './JointFitting.ts'
import {
  BoneNamingStructure, ExportContents, ExportFormat, FbxExportPreset
} from '../lib/processes/export-to-file/DownloadSettings'

type Vec3 = [number, number, number]
type ViewName = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'perspective'
type LabelMode = 'none' | 'main' | 'all'

// ---------------------------------------------------------------------------
// Event bookkeeping: the server waits on these counters instead of DOM state
// ---------------------------------------------------------------------------

const counters = {
  model_loaded: 0,
  skeleton_loaded: 0,
  animations_loaded: 0,
  animations_failed: 0
}

interface DialogRecord { seq: number, title: string, message: string }
const dialogs: DialogRecord[] = []
let dialog_seq = 0
let last_animation_error = ''

function html_to_text (html: string): string {
  const element = document.createElement('div')
  element.innerHTML = html
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim()
}

// every error the app reports to the user goes through ModalDialog, so record them
const original_dialog_show = ModalDialog.prototype.show
ModalDialog.prototype.show = function (this: any): void {
  dialog_seq++
  dialogs.push({ seq: dialog_seq, title: String(this.title), message: html_to_text(String(this.content_html)) })
  if (dialogs.length > 20) dialogs.shift()
  original_dialog_show.call(this)
}

// ---------------------------------------------------------------------------
// Render loop: the engine redraws the scene on every animation frame and the
// animation list plays looping preview videos. Headless, nobody sees either and
// SwiftShader draws them on the CPU, so the server pauses both between tool
// calls. Captures render on demand either way.
// ---------------------------------------------------------------------------

const native_request_frame = window.requestAnimationFrame.bind(window)
const native_cancel_frame = window.cancelAnimationFrame.bind(window)
// frames requested while paused; negative ids keep them apart from the browser's
const held_frames = new Map<number, FrameRequestCallback>()
let held_frame_id = 0
let render_loop_paused = false
const paused_videos = new Set<HTMLVideoElement>()

window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
  if (!render_loop_paused) return native_request_frame(callback)
  held_frame_id--
  held_frames.set(held_frame_id, callback)
  return held_frame_id
}

window.cancelAnimationFrame = (id: number): void => {
  if (id < 0) {
    held_frames.delete(id)
  } else {
    native_cancel_frame(id)
  }
}

// Resuming waits until the held frames ran once, so the tool that resumed the
// loop sees the scene as a running loop would (animation advanced, controls updated).
async function set_render_loop (args: { running: boolean }): Promise<void> {
  render_loop_paused = !args.running
  if (render_loop_paused) {
    for (const video of document.querySelectorAll('video')) {
      if (video.paused) continue
      video.pause()
      paused_videos.add(video)
    }
    return
  }

  for (const video of paused_videos) {
    if (video.isConnected) void video.play().catch(() => undefined)
  }
  paused_videos.clear()
  await new Promise<void>(resolve => {
    native_request_frame((time) => {
      const callbacks = [...held_frames.values()]
      held_frames.clear()
      for (const callback of callbacks) {
        try {
          callback(time)
        } catch (error) {
          reportError(error)
        }
      }
      resolve()
    })
    // a page that gets no frames must not hang the tool call
    setTimeout(resolve, 1000)
  })
}

const engine = new Mesh2MotionEngine()
const ui: any = engine.ui
const listing: any = engine.animations_listing_step

engine.load_model_step.addEventListener('modelLoaded', () => { counters.model_loaded++ })
engine.load_skeleton_step.addEventListener('skeletonLoaded', () => { counters.skeleton_loaded++ })

// onAllAnimationsLoaded runs for both the default library and custom imports
const original_all_loaded = listing.onAllAnimationsLoaded.bind(listing)
listing.onAllAnimationsLoaded = () => {
  original_all_loaded()
  counters.animations_loaded++
}

const animation_loader: any = listing.animation_loader
const original_load_animations = animation_loader.load_animations.bind(animation_loader)
animation_loader.load_animations = async (...args: unknown[]) => {
  try {
    return await original_load_animations(...args)
  } catch (error) {
    last_animation_error = error instanceof Error ? error.message : String(error)
    counters.animations_failed++
    throw error
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const sleep = async (ms: number): Promise<void> => await new Promise(resolve => setTimeout(resolve, ms))

function r (value: number, digits = 4): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function v3 (vector: THREE.Vector3, digits = 4): Vec3 {
  return [r(vector.x, digits), r(vector.y, digits), r(vector.z, digits)]
}

function box_json (box: THREE.Box3): Record<string, Vec3> | null {
  if (box.isEmpty()) return null
  return {
    min: v3(box.min),
    max: v3(box.max),
    size: v3(box.getSize(new THREE.Vector3())),
    center: v3(box.getCenter(new THREE.Vector3()))
  }
}

async function wait_until (label: string, predicate: () => boolean, timeout_ms: number): Promise<void> {
  const dialog_start = dialog_seq
  const start = performance.now()
  while (!predicate()) {
    if (dialog_seq > dialog_start) {
      const dialog = dialogs[dialogs.length - 1]
      throw new Error(`${label} failed. The app reported "${dialog.title}": ${dialog.message}`)
    }
    if (performance.now() - start > timeout_ms) {
      throw new Error(`Timed out after ${Math.round(timeout_ms / 1000)}s waiting for ${label}`)
    }
    await sleep(50)
  }
}

const STEP_NAMES: Record<string, string> = {
  [ProcessStep.LoadModel]: 'load_model',
  [ProcessStep.LoadSkeleton]: 'load_skeleton',
  [ProcessStep.EditSkeleton]: 'edit_skeleton',
  [ProcessStep.BindPose]: 'binding',
  [ProcessStep.AnimationsListing]: 'animations'
}

function step_name (): string {
  return STEP_NAMES[engine.process_step] ?? String(engine.process_step)
}

const STEP_HINTS: Record<string, string> = {
  load_model: 'load a model first (load_model)',
  load_skeleton: 'load a model, then pick a skeleton with select_skeleton',
  edit_skeleton: 'call confirm_skeleton after select_skeleton (or go_back_to_step edit_skeleton from the animations step)',
  animations: 'call bind_skin once the joints are placed'
}

function require_step (...steps: ProcessStep[]): void {
  if (steps.includes(engine.process_step)) return
  const wanted = steps.map(step => STEP_NAMES[step]).join(' or ')
  throw new Error(`This action needs the "${wanted}" step but the app is at "${step_name()}". Hint: ${STEP_HINTS[STEP_NAMES[steps[0]]] ?? ''}`)
}

function skeleton_type (): SkeletonType {
  return engine.load_skeleton_step.skeleton_type()
}

function model_root (): THREE.Object3D {
  return engine.load_model_step.model_meshes()
}

function model_box (): THREE.Box3 {
  const root = model_root()
  root.updateMatrixWorld(true)
  return new THREE.Box3().setFromObject(root, true)
}

// The animated meshes in the animations step, posed at the current mixer time
function skinned_box (): THREE.Box3 {
  const box = new THREE.Box3()
  engine.scene.updateMatrixWorld(true)
  for (const mesh of listing.active_skinned_meshes() as THREE.SkinnedMesh[]) {
    mesh.computeBoundingBox()
    if (mesh.boundingBox !== null) {
      box.union(mesh.boundingBox.clone().applyMatrix4(mesh.matrixWorld))
    }
  }
  return box
}

function bone_world (bone: THREE.Object3D): THREE.Vector3 {
  return bone.getWorldPosition(new THREE.Vector3())
}

function bone_depth (bone: THREE.Object3D): number {
  let depth = 0
  let current = bone.parent
  while (current !== null && (current as THREE.Bone).isBone === true) {
    depth++
    current = current.parent
  }
  return depth
}

function is_detail_bone (name: string): boolean {
  return /(^|[_.\-])(index|middle|ring|pinky|thumb)([_.\-]|\d|$)|leaf|tip$|_end$|\.end$/i.test(name)
}

function bone_side (name: string): 'left' | 'right' | 'center' {
  const lowered = name.toLowerCase()
  if (/(^left|^l_|_l$|\.l$|-l$|_left$|\.left$)/.test(lowered)) return 'left'
  if (/(^right|^r_|_r$|\.r$|-r$|_right$|\.right$)/.test(lowered)) return 'right'
  return 'center'
}

function normalize_name (name: string): string {
  return name.toLowerCase().replace(/[\s_\-.]+/g, '')
}

function suggest (name: string, candidates: string[]): string[] {
  const wanted = normalize_name(name)
  return candidates
    .filter(candidate => normalize_name(candidate).includes(wanted) || wanted.includes(normalize_name(candidate)))
    .slice(0, 8)
}

// ---------------------------------------------------------------------------
// Skeleton the user is currently looking at (preview, edit or animated)
// ---------------------------------------------------------------------------

let preview_armature: THREE.Object3D | null = null

interface BoneSample { name: string, parent: string | null, world: THREE.Vector3 }

function current_bones (): BoneSample[] {
  if (engine.process_step === ProcessStep.EditSkeleton) {
    const skeleton = engine.edit_skeleton_step.skeleton()
    skeleton.bones[0]?.updateWorldMatrix(true, true)
    return skeleton.bones.map(bone => ({
      name: bone.name,
      parent: (bone.parent as THREE.Bone | null)?.isBone === true ? bone.parent!.name : null,
      world: bone_world(bone)
    }))
  }

  if (engine.process_step === ProcessStep.AnimationsListing) {
    const skeleton = engine.weight_skin_step.skeleton()
    if (skeleton === undefined) return []
    engine.scene.updateMatrixWorld(true)
    return skeleton.bones.map(bone => ({
      name: bone.name,
      parent: (bone.parent as THREE.Bone | null)?.isBone === true ? bone.parent!.name : null,
      world: bone_world(bone)
    }))
  }

  if (engine.process_step === ProcessStep.LoadSkeleton && preview_armature !== null) {
    // the preview armature is not in the scene; its group applies the scale
    const scale = engine.load_skeleton_step.skeleton_scale()
    preview_armature.updateMatrixWorld(true)
    const samples: BoneSample[] = []
    preview_armature.traverse((child) => {
      if ((child as THREE.Bone).isBone === true) {
        samples.push({
          name: child.name,
          parent: (child.parent as THREE.Bone | null)?.isBone === true ? child.parent!.name : null,
          world: bone_world(child).multiplyScalar(scale)
        })
      }
    })
    return samples
  }

  return []
}

function joints_box (bones: BoneSample[]): THREE.Box3 {
  const box = new THREE.Box3()
  bones.forEach(bone => box.expandByPoint(bone.world))
  return box
}

// ---------------------------------------------------------------------------
// Status and catalogs
// ---------------------------------------------------------------------------

function model_summary (): Record<string, unknown> {
  const step: any = engine.load_model_step
  return {
    file_name: step.source_file_name,
    vertex_count: step.vertex_count,
    triangle_count: Math.round(step.triangle_count),
    mesh_count: step.objects_count,
    bounding_box: box_json(model_box())
  }
}

function status (): Record<string, unknown> {
  const result: Record<string, unknown> = {
    step: step_name(),
    skeleton_type: skeleton_type(),
    skeleton_scale: engine.load_skeleton_step.skeleton_scale()
  }

  if (engine.process_step !== ProcessStep.LoadModel) {
    result.model = model_summary()
  }

  if (engine.process_step === ProcessStep.EditSkeleton) {
    result.bone_count = engine.edit_skeleton_step.skeleton().bones.length
    result.mirror_mode = engine.edit_skeleton_step.is_mirror_mode_enabled()
    result.skinning_options = skinning_options()
  }

  if (engine.process_step === ProcessStep.AnimationsListing) {
    result.animation_count = listing.animation_clips().length
    result.current_animation = listing.animation_clips()[listing.current_playing_index]?.name ?? null
    result.mirror_animations = listing.mirror_animations_enabled
    result.arm_extension = ArmExtensionControl.getInstance().value()
    result.props = listing.props_manager.selection
  }

  result.recent_dialogs = dialogs.slice(-3)
  return result
}

function catalog (): Record<string, unknown> {
  return {
    rigs: RigConfig.all.map(rig => ({
      skeleton_type: rig.skeleton_type,
      name: rig.rig_display_name,
      builtin_model: rig.model_file,
      animation_files: rig.animation_files.map(file => file.split('/').pop()),
      supports_props: PropCatalog.is_supported_skeleton(rig.skeleton_type),
      supports_hand_options: rig.skeleton_type === SkeletonType.Human,
      supports_mixamo_bone_names: rig.skeleton_type === SkeletonType.Human
    })),
    extra_builtin_models: [{ id: 'human-a-pose', file: 'test-files/bone-correction-tests/human-a-pose.glb' }],
    hand_skeleton_types: Object.values(HandSkeletonType),
    props: PropCatalog.all().map(prop => ({ id: prop.type, name: prop.display_name, category: prop.category })),
    export_formats: Object.values(ExportFormat),
    fbx_presets: Object.values(FbxExportPreset),
    bone_naming: Object.values(BoneNamingStructure),
    export_contents: Object.values(ExportContents)
  }
}

// ---------------------------------------------------------------------------
// Step 1: model
// ---------------------------------------------------------------------------

async function load_builtin_model (args: { file: string, timeout_ms?: number }): Promise<Record<string, unknown>> {
  require_step(ProcessStep.LoadModel)
  const before = counters.model_loaded
  ;(engine.load_model_step as any).source_file_name = args.file.split('/').pop()
  engine.load_model_step.load_model_file(args.file, Utility.get_file_extension(args.file))
  await wait_until('model load', () => counters.model_loaded > before, args.timeout_ms ?? 120000)
  return model_summary()
}

async function wait_for_counter (args: { counter: keyof typeof counters, above: number, label: string, timeout_ms: number }): Promise<void> {
  await wait_until(args.label, () => counters[args.counter] > args.above, args.timeout_ms)
}

function get_counters (): typeof counters {
  return { ...counters }
}

interface TransformModelArgs {
  reset?: boolean
  scale?: number
  target_height?: number
  rotate?: Array<{ axis: 'x' | 'y' | 'z', degrees: number }>
  center_xz?: boolean
  align_to_floor?: boolean
  translate?: Vec3
}

function transform_model (args: TransformModelArgs): Record<string, unknown> {
  require_step(ProcessStep.LoadSkeleton)
  const meshes = engine.load_model_step.model_meshes()
  const applied: string[] = []

  if (args.reset === true) {
    engine.load_model_step.reset_model_position()
    applied.push('reset')
  }

  const apply_scale = (factor: number): void => {
    meshes.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (mesh.isMesh === true) {
        mesh.geometry.scale(factor, factor, factor)
        mesh.geometry.computeBoundingBox()
        mesh.geometry.computeBoundingSphere()
      }
    })
  }

  if (args.scale !== undefined && args.scale !== 1) {
    apply_scale(args.scale)
    applied.push(`scale x${args.scale}`)
  }

  for (const rotation of args.rotate ?? []) {
    ModelCleanupUtility.rotate_model_geometry(meshes, rotation.axis, rotation.degrees)
    applied.push(`rotate ${rotation.axis} ${rotation.degrees}deg`)
  }

  if (args.target_height !== undefined) {
    const height = model_box().getSize(new THREE.Vector3()).y
    if (height > 0) {
      apply_scale(args.target_height / height)
      applied.push(`scale to height ${args.target_height}`)
    }
  }

  if (args.center_xz === true) {
    const center = model_box().getCenter(new THREE.Vector3())
    ModelCleanupUtility.translate_model_vertices(meshes, -center.x, 0, -center.z)
    applied.push('center on X/Z')
  }

  if (args.align_to_floor === true) {
    ModelCleanupUtility.move_model_to_floor(meshes)
    applied.push('align to floor')
  }

  if (args.translate !== undefined) {
    ModelCleanupUtility.translate_model_vertices(meshes, args.translate[0], args.translate[1], args.translate[2])
    applied.push(`translate ${args.translate.join(',')}`)
  }

  return { applied, model: model_summary() }
}

// ---------------------------------------------------------------------------
// Step 2: skeleton template
// ---------------------------------------------------------------------------

const reference_model_boxes = new Map<string, THREE.Box3>()

async function reference_model_box (model_file: string): Promise<THREE.Box3> {
  const cached = reference_model_boxes.get(model_file)
  if (cached !== undefined) return cached
  const gltf = await new GLTFLoader().loadAsync(model_file)
  gltf.scene.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(gltf.scene, true)
  reference_model_boxes.set(model_file, box)
  return box
}

// The rigs are authored to fit their reference model, so matching the user's
// model to the reference model along its dominant axis gives a good first scale.
async function auto_skeleton_scale (type: SkeletonType): Promise<number> {
  const rig = RigConfig.by_skeleton_type(type)
  if (rig === undefined) return 1
  const reference_size = (await reference_model_box(rig.model_file)).getSize(new THREE.Vector3())
  const model_size = model_box().getSize(new THREE.Vector3())
  const axis: 'x' | 'y' | 'z' = reference_size.y >= reference_size.z ? 'y' : 'z'
  if (reference_size[axis] <= 0) return 1
  return r(model_size[axis] / reference_size[axis], 3)
}

async function select_skeleton (args: { type: SkeletonType, hand_type?: HandSkeletonType, scale?: number | 'auto' }): Promise<Record<string, unknown>> {
  require_step(ProcessStep.LoadSkeleton)
  const rig = RigConfig.by_skeleton_type(args.type)
  if (rig === undefined) {
    throw new Error(`Unknown skeleton type "${args.type}". Valid: ${RigConfig.all.map(entry => entry.skeleton_type).join(', ')}`)
  }

  const step: any = engine.load_skeleton_step
  const select = ui.dom_skeleton_drop_type as HTMLSelectElement
  if (select.options[0]?.value === 'select-skeleton') {
    select.options.remove(0)
  }
  select.value = args.type

  if (args.hand_type !== undefined) {
    if (args.type !== SkeletonType.Human) throw new Error('hand_type only applies to the human skeleton')
    ;(ui.dom_hand_skeleton_selection as HTMLSelectElement).value = args.hand_type
  }
  step.toggle_ui_hand_skeleton_options()
  if (ui.dom_scale_skeleton_controls !== null) {
    ui.dom_scale_skeleton_controls.style.display = 'flex'
  }

  let scale: number = step.skeleton_scale()
  if (args.scale === 'auto') {
    scale = await auto_skeleton_scale(args.type)
  } else if (typeof args.scale === 'number') {
    scale = args.scale
  }
  step.skeleton_scale_percentage = scale
  if (ui.dom_scale_skeleton_input !== null) ui.dom_scale_skeleton_input.value = String(scale)
  if (ui.dom_scale_skeleton_percentage_display !== null) {
    ui.dom_scale_skeleton_percentage_display.textContent = `${Math.round(scale * 100)}%`
  }

  preview_armature = await step.refresh_preview_skeleton()
  step.allow_proceeding_to_next_step(true)

  const bones = current_bones()
  const model = model_box()
  const hints: string[] = []
  const model_center = model.getCenter(new THREE.Vector3())
  if (Math.abs(model.min.y) > 0.02 * Math.max(model.getSize(new THREE.Vector3()).y, 0.01)) {
    hints.push(`model bottom is at y=${r(model.min.y, 3)}; the skeleton stands on y=0, consider transform_model align_to_floor`)
  }
  if (Math.hypot(model_center.x, model_center.z) > 0.05 * Math.max(model.getSize(new THREE.Vector3()).length(), 0.01)) {
    hints.push('model is not centered on the X/Z origin; consider transform_model center_xz')
  }

  return {
    skeleton_type: args.type,
    hand_type: args.type === SkeletonType.Human ? (ui.dom_hand_skeleton_selection as HTMLSelectElement).value : null,
    scale,
    bone_count: bones.length,
    joints_bounding_box: box_json(joints_box(bones)),
    model_bounding_box: box_json(model),
    hints
  }
}

async function confirm_skeleton (args: { timeout_ms?: number }): Promise<Record<string, unknown>> {
  require_step(ProcessStep.LoadSkeleton)
  const type = skeleton_type()
  const rig_file = RigConfig.rig_file_for(type)
  if (rig_file === undefined) {
    throw new Error('No skeleton selected yet. Call select_skeleton first.')
  }

  const before = counters.skeleton_loaded
  engine.load_skeleton_step.load_skeleton_file(rig_file)
  await wait_until('skeleton load', () => counters.skeleton_loaded > before && engine.process_step === ProcessStep.EditSkeleton, args.timeout_ms ?? 60000)
  preview_armature = null

  return { skeleton_type: type, ...get_bones({}) }
}

// ---------------------------------------------------------------------------
// Step 3: joints
// ---------------------------------------------------------------------------

function get_bones (args: { include_details?: boolean }): Record<string, unknown> {
  const include_details = args.include_details ?? true
  const step = engine.process_step
  if (step !== ProcessStep.EditSkeleton && step !== ProcessStep.AnimationsListing && step !== ProcessStep.LoadSkeleton) {
    require_step(ProcessStep.EditSkeleton)
  }

  const mirror_lookup = (name: string): string | null => {
    if (step !== ProcessStep.EditSkeleton) return null
    const bone = engine.edit_skeleton_step.skeleton().bones.find(candidate => candidate.name === name)
    if (bone === undefined) return null
    return engine.edit_skeleton_step.find_mirror_bone(bone)?.name ?? null
  }

  const bones = current_bones()
  const listed = bones
    .filter(bone => include_details || !is_detail_bone(bone.name))
    .map(bone => {
      const entry: Record<string, unknown> = { name: bone.name, parent: bone.parent, world: v3(bone.world) }
      const mirror = mirror_lookup(bone.name)
      if (mirror !== null) entry.mirror = mirror
      return entry
    })

  return {
    step: step_name(),
    space: 'world (Y up, character faces +Z, character left side is +X)',
    bone_count: bones.length,
    listed_count: listed.length,
    joints_bounding_box: box_json(joints_box(bones)),
    bones: listed
  }
}

interface BoneEdit { name: string, position?: Vec3, offset?: Vec3, rotation_deg?: Vec3 }

function set_bone_transforms (args: { bones: BoneEdit[], mirror?: boolean, keep_children_in_place?: boolean }): Record<string, unknown> {
  require_step(ProcessStep.EditSkeleton)
  const edit_step = engine.edit_skeleton_step
  const skeleton = edit_step.skeleton()
  const by_name = new Map(skeleton.bones.map(bone => [bone.name, bone]))
  const all_names = skeleton.bones.map(bone => bone.name)
  const mirror = args.mirror ?? true

  const targets = new Map<THREE.Bone, BoneEdit>()
  for (const edit of args.bones) {
    const bone = by_name.get(edit.name)
    if (bone === undefined) {
      const close = suggest(edit.name, all_names)
      throw new Error(`Unknown bone "${edit.name}".${close.length > 0 ? ' Did you mean: ' + close.join(', ') + '?' : ' Call get_bones for the list.'}`)
    }
    if (bone === skeleton.bones[0] && bone.name === 'root') {
      throw new Error('The root bone stays at the origin; move the child bones (e.g. pelvis/hips) instead.')
    }
    if (edit.position === undefined && edit.offset === undefined && edit.rotation_deg === undefined) {
      throw new Error(`Bone "${edit.name}" needs position, offset or rotation_deg`)
    }
    targets.set(bone, edit)
  }

  // mirror left/right edits onto the counterpart unless both sides were given
  const mirrored: string[] = []
  if (mirror) {
    for (const [bone, edit] of [...targets.entries()]) {
      const counterpart = edit_step.find_mirror_bone(bone)
      if (counterpart === undefined || targets.has(counterpart)) continue
      targets.set(counterpart, {
        name: counterpart.name,
        position: edit.position !== undefined ? [-edit.position[0], edit.position[1], edit.position[2]] : undefined,
        offset: edit.offset !== undefined ? [-edit.offset[0], edit.offset[1], edit.offset[2]] : undefined,
        rotation_deg: edit.rotation_deg !== undefined ? [edit.rotation_deg[0], -edit.rotation_deg[1], -edit.rotation_deg[2]] : undefined
      })
      mirrored.push(counterpart.name)
    }
  }

  skeleton.bones[0].updateWorldMatrix(true, true)
  const snapshot = new Map(skeleton.bones.map(bone => [bone, bone_world(bone)]))

  edit_step.store_bone_state_for_undo()

  // parents first so absolute positions of children are honored
  const ordered = [...targets.entries()].sort((a, b) => bone_depth(a[0]) - bone_depth(b[0]))
  for (const [bone, edit] of ordered) {
    if (edit.rotation_deg !== undefined) {
      bone.rotation.set(
        THREE.MathUtils.degToRad(edit.rotation_deg[0]),
        THREE.MathUtils.degToRad(edit.rotation_deg[1]),
        THREE.MathUtils.degToRad(edit.rotation_deg[2])
      )
    }

    let target_world: THREE.Vector3 | null = null
    if (edit.position !== undefined) {
      target_world = new THREE.Vector3(...edit.position)
    } else if (edit.offset !== undefined) {
      target_world = (snapshot.get(bone) ?? bone_world(bone)).clone().add(new THREE.Vector3(...edit.offset))
    }

    if (target_world !== null && bone.parent !== null) {
      bone.parent.updateWorldMatrix(true, false)
      bone.position.copy(bone.parent.worldToLocal(target_world.clone()))
    }
    bone.updateWorldMatrix(false, true)
  }

  if (args.keep_children_in_place === true) {
    const untouched = skeleton.bones
      .filter(bone => !targets.has(bone) && bone !== skeleton.bones[0])
      .sort((a, b) => bone_depth(a) - bone_depth(b))
    for (const bone of untouched) {
      if (bone.parent === null) continue
      bone.parent.updateWorldMatrix(true, false)
      bone.position.copy(bone.parent.worldToLocal(snapshot.get(bone)!.clone()))
      bone.updateWorldMatrix(false, true)
    }
  }

  edit_step.dispatchEvent(new CustomEvent('skeletonTransformed'))

  skeleton.bones[0].updateWorldMatrix(true, true)
  return {
    updated: ordered.map(([bone]) => ({ name: bone.name, world: v3(bone_world(bone)) })),
    mirrored,
    note: args.keep_children_in_place === true ? 'children kept their world positions' : 'children moved together with their parents'
  }
}

function edit_history (args: { action: 'undo' | 'redo' }): Record<string, unknown> {
  require_step(ProcessStep.EditSkeleton)
  const ok = args.action === 'undo'
    ? engine.edit_skeleton_step.undo_bone_transformation()
    : engine.edit_skeleton_step.redo_bone_transformation()
  return { action: args.action, applied: ok }
}

function skinning_options (): Record<string, unknown> {
  const edit_step = engine.edit_skeleton_step
  return {
    head_weight_correction: edit_step.use_head_weight_correction(),
    head_correction_height: edit_step.get_preview_plane_height(),
    arm_plane_correction: edit_step.use_arm_plane_correction(),
    arm_plane_offset: edit_step.get_arm_plane_offset(),
    preview: engine.mesh_preview_display_type === ModelPreviewDisplay.WeightPainted ? 'weights' : 'textured'
  }
}

function set_skinning_options (args: {
  head_weight_correction?: boolean
  head_correction_height?: number
  arm_plane_correction?: boolean
  arm_plane_offset?: number
  preview?: 'textured' | 'weights'
}): Record<string, unknown> {
  require_step(ProcessStep.EditSkeleton)
  const edit_step = engine.edit_skeleton_step
  const is_human = skeleton_type() === SkeletonType.Human

  if ((args.head_weight_correction !== undefined || args.arm_plane_correction !== undefined) && !is_human) {
    throw new Error('Head weight and arm plane corrections are only available for the human skeleton')
  }
  if (args.head_correction_height !== undefined) edit_step.set_preview_plane_height(args.head_correction_height)
  if (args.head_weight_correction !== undefined) edit_step.set_use_head_weight_correction(args.head_weight_correction)
  if (args.arm_plane_offset !== undefined) edit_step.set_arm_plane_offset(args.arm_plane_offset)
  if (args.arm_plane_correction !== undefined) {
    edit_step.set_use_arm_plane_correction(args.arm_plane_correction)
    if (ui.dom_arm_plane_checkbox !== null) ui.dom_arm_plane_checkbox.checked = args.arm_plane_correction
  }

  if (args.preview !== undefined) {
    engine.changed_model_preview_display(args.preview === 'weights' ? ModelPreviewDisplay.WeightPainted : ModelPreviewDisplay.Textured)
  } else if (engine.mesh_preview_display_type === ModelPreviewDisplay.WeightPainted) {
    engine.regenerate_weight_painted_preview_mesh()
  }

  return skinning_options()
}

// ---------------------------------------------------------------------------
// Step 4: skin + animations
// ---------------------------------------------------------------------------

async function bind_skin (args: { timeout_ms?: number }): Promise<Record<string, unknown>> {
  require_step(ProcessStep.EditSkeleton)
  const loaded_before = counters.animations_loaded
  const failed_before = counters.animations_failed

  engine.setup_weight_skinning_config()
  engine.process_step_changed(ProcessStep.BindPose)

  await wait_until(
    'animation library load',
    () => counters.animations_loaded > loaded_before || counters.animations_failed > failed_before,
    args.timeout_ms ?? 180000
  )
  if (counters.animations_failed > failed_before) {
    throw new Error(`Skinning worked but the animation library failed to load: ${last_animation_error}`)
  }

  const clips = listing.animation_clips() as THREE.AnimationClip[]
  return {
    step: step_name(),
    skinned_meshes: listing.active_skinned_meshes().length,
    bone_count: engine.weight_skin_step.skeleton()?.bones.length ?? 0,
    animation_count: clips.length,
    first_animations: clips.slice(0, 15).map(clip => clip.name)
  }
}

function go_back_to_step (args: { step: 'edit_skeleton' | 'load_skeleton' }): Record<string, unknown> {
  const current = engine.process_step
  if (args.step === 'edit_skeleton') {
    require_step(ProcessStep.AnimationsListing, ProcessStep.EditSkeleton)
  } else {
    require_step(ProcessStep.AnimationsListing, ProcessStep.EditSkeleton, ProcessStep.LoadSkeleton)
  }

  if (current === ProcessStep.AnimationsListing) {
    listing.props_manager.detach_all()
    engine.remove_skinned_meshes_from_scene()
    engine.debugging_visual_object = Utility.regenerate_debugging_scene(engine.scene)
  }

  if (args.step === 'edit_skeleton') {
    engine.process_step = engine.process_step_changed(ProcessStep.EditSkeleton)
    engine.edit_skeleton_step.set_currently_selected_bone(null)
    engine.edit_skeleton_step.clear_undo_history()
  } else {
    engine.process_step = engine.process_step_changed(ProcessStep.LoadSkeleton)
    preview_armature = null
  }
  return status()
}

function find_animation_index (name: string): number {
  const clips = listing.animation_clips() as THREE.AnimationClip[]
  let index = clips.findIndex(clip => clip.name === name)
  if (index === -1) {
    const wanted = normalize_name(name)
    index = clips.findIndex(clip => normalize_name(clip.name) === wanted)
  }
  if (index === -1) {
    const close = suggest(name, clips.map(clip => clip.name))
    throw new Error(`Unknown animation "${name}".${close.length > 0 ? ' Close matches: ' + close.join(', ') : ' Use list_animations to see the names.'}`)
  }
  return index
}

function list_animations (args: { filter?: string, offset?: number, limit?: number }): Record<string, unknown> {
  require_step(ProcessStep.AnimationsListing)
  const clips = listing.animation_clips() as THREE.AnimationClip[]
  const filter = args.filter?.toLowerCase().trim() ?? ''
  const terms = filter.split(/\s+/).filter(term => term.length > 0)

  const matching = clips
    .map((clip, index) => ({ clip, index }))
    .filter(({ clip }) => terms.every(term => clip.name.toLowerCase().replace(/_/g, ' ').includes(term)))

  const offset = args.offset ?? 0
  const limit = args.limit ?? 200
  return {
    total: clips.length,
    matching: matching.length,
    offset,
    animations: matching.slice(offset, offset + limit).map(({ clip, index }) => {
      const metadata = listing.get_animation_metadata(index)
      return {
        name: clip.name,
        duration_s: r(clip.duration, 2),
        source: metadata?.source_type === 'custom-import' ? 'custom' : 'library'
      }
    })
  }
}

function animation_actions (): THREE.AnimationAction[] {
  return listing.animation_player.current_animation_actions as THREE.AnimationAction[]
}

function pose_at (time: number): void {
  listing.animation_player.pause()
  for (const action of animation_actions()) {
    action.time = time
  }
  listing.mixer().update(0)
  engine.scene.updateMatrixWorld(true)
}

function play_animation (args: { name: string, time?: number, paused?: boolean }): Record<string, unknown> {
  require_step(ProcessStep.AnimationsListing)
  const index = find_animation_index(args.name)
  listing.play_animation(index)
  listing.animation_player.play()

  const clip = (listing.animation_clips() as THREE.AnimationClip[])[index]
  if (args.time !== undefined || args.paused === true) {
    pose_at(Math.min(Math.max(args.time ?? 0, 0), clip.duration))
  }
  return {
    name: clip.name,
    duration_s: r(clip.duration, 3),
    time_s: r(animation_actions()[0]?.time ?? 0, 3),
    playing: listing.animation_player.get_is_playing()
  }
}

function set_animation_options (args: { mirror?: boolean, arm_extension?: number }): Record<string, unknown> {
  require_step(ProcessStep.AnimationsListing)

  if (args.mirror !== undefined) {
    listing.mirror_animations_enabled = args.mirror
    if (ui.dom_mirror_animations_checkbox !== null) ui.dom_mirror_animations_checkbox.checked = args.mirror
    listing.rebuild_warped_animations()
    listing.play_animation(listing.current_playing_index)
  }

  if (args.arm_extension !== undefined) {
    if (skeleton_type() !== SkeletonType.Human) {
      throw new Error('arm_extension (A-pose correction) is only available for the human skeleton')
    }
    // set_value notifies the listing step, which rebuilds and replays the clips
    ArmExtensionControl.getInstance().set_value(args.arm_extension)
  }

  return {
    mirror: listing.mirror_animations_enabled,
    arm_extension: ArmExtensionControl.getInstance().value()
  }
}

async function set_props (args: { left?: PropType, right?: PropType }): Promise<Record<string, unknown>> {
  require_step(ProcessStep.AnimationsListing)
  if (!PropCatalog.is_supported_skeleton(skeleton_type())) {
    throw new Error(`Props are only supported for: ${PropCatalog.supported_skeleton_types.join(', ')}`)
  }

  const valid = new Set<string>(Object.values(PropType))
  for (const value of [args.left, args.right]) {
    if (value !== undefined && !valid.has(value)) {
      throw new Error(`Unknown prop "${value}". Use list_catalog to see the prop ids, or "none".`)
    }
  }

  const props_manager = listing.props_manager
  const selection = {
    left: args.left ?? props_manager.selection.left,
    right: args.right ?? props_manager.selection.right
  }
  props_manager.selection = selection
  props_manager.panel.set_selection(selection)
  props_manager.refresh_attached_props()

  const expected = [selection.left, selection.right].filter(prop => prop !== PropType.None).length
  try {
    await wait_until('props to attach', () => props_manager.attached_props.length >= expected, 20000)
  } catch {
    // a rig without hand bones simply attaches fewer props
  }
  return { selection, attached: props_manager.attached_props.length }
}

interface ExportArgs {
  animations: Array<{ name: string, mirror?: 'none' | 'mirrored' | 'both' }>
  format: ExportFormat
  fbx_preset?: FbxExportPreset
  bone_naming?: BoneNamingStructure
  contents?: ExportContents
  filename: string
}

async function export_model (args: ExportArgs): Promise<Record<string, unknown>> {
  require_step(ProcessStep.AnimationsListing)
  if (args.animations.length === 0) {
    throw new Error('Pick at least one animation to export (Mesh2Motion always exports with animations)')
  }
  if (args.bone_naming === BoneNamingStructure.Mixamo && skeleton_type() !== SkeletonType.Human) {
    throw new Error('Mixamo bone naming is only available for the human skeleton')
  }

  const clips = listing.animation_clips() as THREE.AnimationClip[]
  const selections = args.animations.map(entry => ({
    animation_index: find_animation_index(entry.name),
    mirror_export_mode: entry.mirror ?? 'none'
  }))

  const settings: any = engine.download_settings
  settings.selected_export_format = args.format
  settings.selected_fbx_export_preset = args.fbx_preset ?? FbxExportPreset.Unreal
  settings.selected_bone_naming_structure = args.bone_naming ?? BoneNamingStructure.Default
  settings.selected_export_contents = args.contents ?? ExportContents.Full

  engine.file_export_step.set_animation_clips_to_export(clips, selections)
  await engine.file_export_step.export(listing.active_skinned_meshes(), args.filename, engine.download_settings)

  return {
    clip_count: (engine.file_export_step as any).animation_clips_to_export.length,
    animations: selections.map(selection => ({ name: clips[selection.animation_index].name, mirror: selection.mirror_export_mode }))
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

interface CaptureArgs {
  view?: ViewName
  width?: number
  height?: number
  show_skeleton?: boolean
  labels?: LabelMode
  grid?: boolean
  show_floor?: boolean
  background?: string
  focus?: 'auto' | 'model' | 'skeleton'
  zoom?: number
}

const VIEW_DIRECTIONS: Record<ViewName, Vec3> = {
  front: [0, 0, 1],
  back: [0, 0, -1],
  left: [1, 0, 0], // character's left side is +X
  right: [-1, 0, 0],
  top: [0, 1, 0],
  bottom: [0, -1, 0],
  perspective: [0.75, 0.45, 1.3]
}

interface ViewSetup {
  camera: THREE.Camera
  ortho: boolean
  center: THREE.Vector3
  screen_right: THREE.Vector3
  screen_up: THREE.Vector3
  world_width: number
  world_height: number
}

function focus_box (focus: CaptureArgs['focus']): THREE.Box3 {
  const bones = current_bones()
  if (focus === 'skeleton' && bones.length > 0) return joints_box(bones)

  const box = engine.process_step === ProcessStep.AnimationsListing ? skinned_box() : model_box()
  if (focus !== 'model') box.union(joints_box(bones))
  if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(0, 1, 0), new THREE.Vector3(2, 2, 2))
  return box
}

function build_view (view: ViewName, box: THREE.Box3, aspect: number, zoom: number): ViewSetup {
  const center = box.getCenter(new THREE.Vector3())
  const size = box.getSize(new THREE.Vector3())
  const radius = Math.max(size.length() / 2, 0.05)
  const direction = new THREE.Vector3(...VIEW_DIRECTIONS[view]).normalize()
  const up = view === 'top' ? new THREE.Vector3(0, 0, -1) : view === 'bottom' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0)

  if (view === 'perspective') {
    const fov = 30
    const camera = new THREE.PerspectiveCamera(fov, aspect, radius / 100, radius * 100)
    const fit_fov = THREE.MathUtils.degToRad(aspect < 1 ? fov * aspect : fov)
    const distance = radius / Math.sin(fit_fov / 2) * 1.05 / zoom
    camera.up.copy(up)
    camera.position.copy(center).addScaledVector(direction, distance)
    camera.lookAt(center)
    camera.updateMatrixWorld(true)
    camera.updateProjectionMatrix()
    const screen_right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
    const screen_up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1)
    return { camera, ortho: false, center, screen_right, screen_up, world_width: 0, world_height: 0 }
  }

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, radius / 100, radius * 20)
  camera.up.copy(up)
  camera.position.copy(center).addScaledVector(direction, radius * 4)
  camera.lookAt(center)
  camera.updateMatrixWorld(true)

  const screen_right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
  const screen_up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1)

  // project the box corners on the screen axes to find the extents
  let half_width = 0
  let half_height = 0
  for (let i = 0; i < 8; i++) {
    const corner = new THREE.Vector3(
      (i & 1) !== 0 ? box.max.x : box.min.x,
      (i & 2) !== 0 ? box.max.y : box.min.y,
      (i & 4) !== 0 ? box.max.z : box.min.z
    ).sub(center)
    half_width = Math.max(half_width, Math.abs(corner.dot(screen_right)))
    half_height = Math.max(half_height, Math.abs(corner.dot(screen_up)))
  }
  half_width = Math.max(half_width, 0.01) * 1.12 / zoom
  half_height = Math.max(half_height, 0.01) * 1.12 / zoom
  if (half_width / half_height > aspect) {
    half_height = half_width / aspect
  } else {
    half_width = half_height * aspect
  }

  camera.left = -half_width
  camera.right = half_width
  camera.top = half_height
  camera.bottom = -half_height
  camera.updateProjectionMatrix()

  return { camera, ortho: true, center, screen_right, screen_up, world_width: half_width * 2, world_height: half_height * 2 }
}

function axis_label (vector: THREE.Vector3): string {
  const components: Array<['x' | 'y' | 'z', number]> = [['x', vector.x], ['y', vector.y], ['z', vector.z]]
  const [axis, value] = components.reduce((best, entry) => Math.abs(entry[1]) > Math.abs(best[1]) ? entry : best)
  return `${value >= 0 ? '+' : '-'}${axis.toUpperCase()}`
}

function nice_step (range: number, target_ticks: number): number {
  const raw = range / target_ticks
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const normalized = raw / magnitude
  const nice = normalized < 1.5 ? 1 : normalized < 3.5 ? 2 : normalized < 7.5 ? 5 : 10
  return nice * magnitude
}

function format_number (value: number, step: number): string {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)))
  const text = value.toFixed(Math.min(decimals, 4))
  return /^-0(\.0*)?$/.test(text) ? text.slice(1) : text
}

function draw_text (ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void {
  ctx.lineWidth = 3
  ctx.strokeStyle = 'rgba(0,0,0,0.85)'
  ctx.strokeText(text, x, y)
  ctx.fillStyle = color
  ctx.fillText(text, x, y)
}

// grid labels sit on a dark box so the grid lines running behind them don't read as minus signs
function draw_grid_label (ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  const text_width = ctx.measureText(text).width
  const left = ctx.textAlign === 'center' ? x - text_width / 2 : x
  ctx.fillStyle = 'rgba(30,32,36,0.85)'
  ctx.fillRect(left - 2, y - 7, text_width + 4, 14)
  ctx.fillStyle = '#d8d8d8'
  ctx.fillText(text, x, y)
}

function draw_grid (ctx: CanvasRenderingContext2D, setup: ViewSetup, width: number, height: number): string {
  const horizontal_axis = axis_label(setup.screen_right)
  const vertical_axis = axis_label(setup.screen_up)
  const h_index = horizontal_axis[1].toLowerCase() as 'x' | 'y' | 'z'
  const v_index = vertical_axis[1].toLowerCase() as 'x' | 'y' | 'z'
  const h_sign = horizontal_axis[0] === '+' ? 1 : -1
  const v_sign = vertical_axis[0] === '+' ? 1 : -1

  const step = nice_step(Math.max(setup.world_width, setup.world_height), 10)
  ctx.font = '11px monospace'
  ctx.textBaseline = 'middle'

  // world coordinate along an axis -> pixel
  const h_min = setup.center[h_index] - h_sign * setup.world_width / 2
  const h_max = setup.center[h_index] + h_sign * setup.world_width / 2
  for (let value = Math.ceil(Math.min(h_min, h_max) / step) * step; value <= Math.max(h_min, h_max); value += step) {
    const px = ((value - setup.center[h_index]) * h_sign / setup.world_width + 0.5) * width
    const is_zero = Math.abs(value) < step / 1000
    ctx.strokeStyle = is_zero ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.13)'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(px + 0.5, 0); ctx.lineTo(px + 0.5, height); ctx.stroke()
    ctx.textAlign = 'center'
    draw_grid_label(ctx, format_number(value, step), px, height - 9)
  }

  const v_min = setup.center[v_index] - v_sign * setup.world_height / 2
  const v_max = setup.center[v_index] + v_sign * setup.world_height / 2
  for (let value = Math.ceil(Math.min(v_min, v_max) / step) * step; value <= Math.max(v_min, v_max); value += step) {
    const py = (0.5 - (value - setup.center[v_index]) * v_sign / setup.world_height) * height
    const is_zero = Math.abs(value) < step / 1000
    ctx.strokeStyle = is_zero ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.13)'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(0, py + 0.5); ctx.lineTo(width, py + 0.5); ctx.stroke()
    ctx.textAlign = 'left'
    draw_grid_label(ctx, format_number(value, step), 4, py)
  }

  return `grid step ${step}; horizontal axis ${horizontal_axis} (${h_index}), vertical axis ${vertical_axis} (${v_index})`
}

const SIDE_COLORS = { left: '#4fd1ff', right: '#ffa040', center: '#ffe14f' }

function draw_bone_labels (ctx: CanvasRenderingContext2D, camera: THREE.Camera, width: number, height: number, mode: LabelMode): void {
  const bones = current_bones().filter(bone => mode === 'all' || !is_detail_bone(bone.name))
  const placed: Array<[number, number, number, number]> = []
  ctx.font = '11px sans-serif'
  ctx.textBaseline = 'middle'
  const center_px = width / 2

  for (const bone of bones) {
    const ndc = bone.world.clone().project(camera)
    if (ndc.z < -1 || ndc.z > 1) continue
    const px = (ndc.x + 1) / 2 * width
    const py = (1 - ndc.y) / 2 * height
    const color = SIDE_COLORS[bone_side(bone.name)]

    ctx.fillStyle = color
    ctx.strokeStyle = 'rgba(0,0,0,0.9)'
    ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.arc(px, py, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke()

    const text = bone.name
    const text_width = ctx.measureText(text).width
    const to_right = px >= center_px
    let tx = to_right ? px + 6 : px - 6 - text_width
    let ty = py
    for (let attempt = 0; attempt < 6; attempt++) {
      const overlaps = placed.some(([x, y, w, h]) => tx < x + w && tx + text_width > x && ty - 6 < y + h && ty + 6 > y)
      if (!overlaps) break
      ty += 12
    }
    tx = Math.min(Math.max(tx, 2), width - text_width - 2)
    placed.push([tx, ty - 6, text_width, 12])
    ctx.textAlign = 'left'
    draw_text(ctx, text, tx, ty, color)
  }
}

interface RenderOptions {
  width: number
  height: number
  show_skeleton: boolean
  show_floor: boolean
  background: string
}

// Renders one frame of the live scene with a temporary camera. The WebGL
// canvas is read back in the same task, so preserveDrawingBuffer isn't needed.
function render_scene (camera: THREE.Camera, options: RenderOptions): HTMLCanvasElement {
  const renderer = engine.renderer
  const scene = engine.scene

  const previous_size = renderer.getSize(new THREE.Vector2())
  const previous_ratio = renderer.getPixelRatio()
  const previous_clear = renderer.getClearColor(new THREE.Color())
  const previous_alpha = renderer.getClearAlpha()
  const previous_fog = scene.fog

  const hidden: Array<[THREE.Object3D, boolean]> = []
  const hide = (object: THREE.Object3D | undefined | null, visible = false): void => {
    if (object === undefined || object === null) return
    hidden.push([object, object.visible])
    object.visible = visible
  }
  hide(engine.transform_controls.getHelper())
  hide(scene.getObjectByName('Joint Hover Point'))
  if (engine.skeleton_helper !== undefined) hide(engine.skeleton_helper, options.show_skeleton)

  // the floor's origin gizmo is oversized next to small models; the grid overlay shows the axes
  for (const child of scene.getObjectByName('Setup objects')?.children ?? []) {
    if (child.name === 'Forward Direction Arrow' || child.name === 'Axes Helper') {
      hide(child)
    } else if (!options.show_floor && (child.name === 'Floor Mesh' || child.type === 'GridHelper')) {
      hide(child)
    }
  }

  try {
    scene.fog = null
    renderer.setPixelRatio(1)
    renderer.setSize(options.width, options.height, false)
    renderer.setClearColor(new THREE.Color(options.background), 1)
    renderer.clear()
    renderer.render(scene, camera)

    const output = document.createElement('canvas')
    output.width = options.width
    output.height = options.height
    output.getContext('2d')!.drawImage(renderer.domElement, 0, 0)
    return output
  } finally {
    for (const [object, visible] of hidden) object.visible = visible
    scene.fog = previous_fog
    renderer.setClearColor(previous_clear, previous_alpha)
    renderer.setPixelRatio(previous_ratio)
    renderer.setSize(previous_size.x, previous_size.y, false)
  }
}

function default_show_skeleton (): boolean {
  return engine.process_step === ProcessStep.EditSkeleton || engine.process_step === ProcessStep.LoadSkeleton
}

function capture (args: CaptureArgs): Record<string, unknown> {
  const view = args.view ?? 'front'
  if (!(view in VIEW_DIRECTIONS)) throw new Error(`Unknown view "${view}"`)
  const width = Math.round(args.width ?? 768)
  const height = Math.round(args.height ?? 768)
  const show_skeleton = args.show_skeleton ?? default_show_skeleton()
  const labels: LabelMode = args.labels ?? (show_skeleton ? 'main' : 'none')

  const setup = build_view(view, focus_box(args.focus ?? 'auto'), width / height, args.zoom ?? 1)
  const canvas = render_scene(setup.camera, {
    width,
    height,
    show_skeleton,
    show_floor: args.show_floor ?? true,
    background: args.background ?? '#30343b'
  })

  const ctx = canvas.getContext('2d')!
  let grid_note = ''
  if (setup.ortho && (args.grid ?? true)) grid_note = draw_grid(ctx, setup, width, height)
  if (labels !== 'none') draw_bone_labels(ctx, setup.camera, width, height, labels)

  ctx.font = 'bold 12px sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  draw_text(ctx, `${view} view | screen right ${axis_label(setup.screen_right)}, up ${axis_label(setup.screen_up)} | step: ${step_name()}`, 8, 6, '#ffffff')

  const result: Record<string, unknown> = {
    image: canvas.toDataURL('image/png'),
    view,
    projection: setup.ortho ? 'orthographic' : 'perspective',
    screen_right: axis_label(setup.screen_right),
    screen_up: axis_label(setup.screen_up),
    step: step_name()
  }
  if (setup.ortho) {
    result.visible_world_area = {
      center: v3(setup.center),
      width: r(setup.world_width),
      height: r(setup.world_height)
    }
    result.grid = grid_note
  }
  return result
}

function animation_sheet (args: {
  name: string
  frames?: number
  columns?: number
  view?: ViewName
  cell_width?: number
  cell_height?: number
  show_skeleton?: boolean
  background?: string
}): Record<string, unknown> {
  require_step(ProcessStep.AnimationsListing)
  const index = find_animation_index(args.name)
  const clip = (listing.animation_clips() as THREE.AnimationClip[])[index]
  const frames = Math.min(Math.max(Math.round(args.frames ?? 8), 1), 36)
  const columns = Math.min(Math.max(Math.round(args.columns ?? Math.min(frames, 4)), 1), frames)
  const rows = Math.ceil(frames / columns)
  const cell_width = Math.round(args.cell_width ?? 256)
  const cell_height = Math.round(args.cell_height ?? 256)
  const view = args.view ?? 'front'
  const was_playing: boolean = listing.animation_player.get_is_playing()
  const previous_index: number = listing.current_playing_index

  listing.play_animation(index)
  const times = Array.from({ length: frames }, (_, i) => frames === 1 ? 0 : clip.duration * i / frames)

  // one camera for every frame so motion between cells is readable
  const union = new THREE.Box3()
  for (const time of times) {
    pose_at(time)
    union.union(skinned_box())
  }
  const setup = build_view(view, union, cell_width / cell_height, 1)

  const sheet = document.createElement('canvas')
  sheet.width = cell_width * columns
  sheet.height = cell_height * rows
  const ctx = sheet.getContext('2d')!
  ctx.fillStyle = args.background ?? '#30343b'
  ctx.fillRect(0, 0, sheet.width, sheet.height)

  times.forEach((time, i) => {
    pose_at(time)
    const cell = render_scene(setup.camera, {
      width: cell_width,
      height: cell_height,
      show_skeleton: args.show_skeleton ?? false,
      show_floor: true,
      background: args.background ?? '#30343b'
    })
    const x = (i % columns) * cell_width
    const y = Math.floor(i / columns) * cell_height
    ctx.drawImage(cell, x, y)
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'
    ctx.strokeRect(x + 0.5, y + 0.5, cell_width - 1, cell_height - 1)
    ctx.font = '11px monospace'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    draw_text(ctx, `#${i + 1} t=${time.toFixed(2)}s`, x + 5, y + 5, '#ffffff')
  })

  // leave the app the way we found it
  listing.play_animation(was_playing ? index : previous_index)
  if (!was_playing) pose_at(0)

  return {
    image: sheet.toDataURL('image/png'),
    name: clip.name,
    duration_s: r(clip.duration, 3),
    frames,
    times_s: times.map(time => r(time, 3)),
    view,
    layout: `${columns} columns x ${rows} rows, read left to right, top to bottom`
  }
}

// ---------------------------------------------------------------------------
// Mesh analysis to help place joints without looking at pixels
// ---------------------------------------------------------------------------

function analyze_model (args: { slices?: number, axis?: 'y' | 'z' }): Record<string, unknown> {
  require_step(ProcessStep.LoadSkeleton, ProcessStep.EditSkeleton, ProcessStep.AnimationsListing)
  const slice_count = Math.min(Math.max(Math.round(args.slices ?? 24), 4), 80)
  const slice_axis = args.axis ?? 'y'
  const root = model_root()
  root.updateMatrixWorld(true)

  const points: THREE.Vector3[] = []
  root.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (mesh.isMesh !== true) return
    const positions = mesh.geometry.attributes.position
    const stride = Math.max(1, Math.floor(positions.count / 60000))
    for (let i = 0; i < positions.count; i += stride) {
      points.push(new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld))
    }
  })
  if (points.length === 0) throw new Error('The model has no vertices')

  const box = new THREE.Box3().setFromPoints(points)
  const size = box.getSize(new THREE.Vector3())
  const span_axis = 'x'
  const depth_axis = slice_axis === 'y' ? 'z' : 'y'
  const slice_size = size[slice_axis] / slice_count
  const gap_threshold = Math.max(size[span_axis] * 0.02, 1e-4)

  const slices = []
  for (let s = 0; s < slice_count; s++) {
    const low = box.min[slice_axis] + slice_size * s
    const high = low + slice_size
    const in_slice = points.filter(point => point[slice_axis] >= low && point[slice_axis] < high + (s === slice_count - 1 ? 1e-6 : 0))
    if (in_slice.length === 0) {
      slices.push({ [slice_axis]: [r(low, 3), r(high, 3)], vertices: 0 })
      continue
    }

    // split the horizontal span into islands (legs, arms vs torso, ...)
    const sorted = in_slice.map(point => point[span_axis]).sort((a, b) => a - b)
    const islands: Array<[number, number]> = []
    let start = sorted[0]
    let previous = sorted[0]
    for (const value of sorted.slice(1)) {
      if (value - previous > gap_threshold) {
        islands.push([r(start, 3), r(previous, 3)])
        start = value
      }
      previous = value
    }
    islands.push([r(start, 3), r(previous, 3)])

    let depth_min = Infinity
    let depth_max = -Infinity
    for (const point of in_slice) {
      depth_min = Math.min(depth_min, point[depth_axis])
      depth_max = Math.max(depth_max, point[depth_axis])
    }
    slices.push({
      [slice_axis]: [r(low, 3), r(high, 3)],
      vertices: in_slice.length,
      [`${span_axis}_islands`]: islands.slice(0, 6),
      [`${depth_axis}_range`]: [r(depth_min, 3), r(depth_max, 3)]
    })
  }

  return {
    bounding_box: box_json(box),
    sampled_vertices: points.length,
    slice_axis,
    note: `Slices go from low to high ${slice_axis}. "${span_axis}_islands" are separate solid spans along ${span_axis} in that slice (e.g. two legs, or arm / torso / arm in a T-pose).`,
    slices
  }
}

// ---------------------------------------------------------------------------
// Automatic joint placement (human rig in T-pose)
// ---------------------------------------------------------------------------

// World-space triangles of every mesh of the model, 9 floats each
function model_triangles (): Float32Array {
  const root = model_root()
  root.updateMatrixWorld(true)
  const chunks: Float32Array[] = []
  const vertex = new THREE.Vector3()
  root.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (mesh.isMesh !== true) return
    const positions = mesh.geometry.attributes.position
    const index = mesh.geometry.index
    const corners = index !== null ? index.count : positions.count
    const chunk = new Float32Array(Math.floor(corners / 3) * 9)
    for (let k = 0; k < chunk.length / 3; k++) {
      vertex.fromBufferAttribute(positions, index !== null ? index.getX(k) : k).applyMatrix4(mesh.matrixWorld)
      chunk[k * 3] = vertex.x
      chunk[k * 3 + 1] = vertex.y
      chunk[k * 3 + 2] = vertex.z
    }
    chunks.push(chunk)
  })
  const triangles = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    triangles.set(chunk, offset)
    offset += chunk.length
  }
  return triangles
}

function auto_place_joints (args: { markers?: BodyMarkers, symmetric?: boolean }): Record<string, unknown> {
  require_step(ProcessStep.EditSkeleton)
  if (skeleton_type() !== SkeletonType.Human) {
    throw new Error('auto_place_joints works with the human skeleton only; place the joints of other rigs with set_bones')
  }

  const fit = fit_human_joints({
    triangles: model_triangles(),
    template: current_bones().map(bone => ({ name: bone.name, parent: bone.parent, world: v3(bone.world, 6) })),
    markers: args.markers,
    symmetric: args.symmetric
  })
  const edits = Object.entries(fit.joints).map(([name, position]) => ({ name, position: [r(position[0]), r(position[1]), r(position[2])] as Vec3 }))
  set_bone_transforms({ bones: edits, mirror: false })
  // the head weight correction plane goes just under the chin (it only acts once enabled)
  engine.edit_skeleton_step.set_preview_plane_height(r(fit.head_correction_height, 3))

  const round = (values: Record<string, number[]>): Record<string, number[]> =>
    Object.fromEntries(Object.entries(values).map(([name, value]) => [name, value.map(component => r(component, 3))]))
  return {
    placed: edits.length,
    confidence: fit.confidence,
    sources: fit.sources,
    notes: fit.notes,
    landmarks: round(fit.landmarks),
    joints: round(Object.fromEntries(Object.entries(fit.joints).filter(([name]) => !is_detail_bone(name)))),
    head_correction_height: r(fit.head_correction_height, 3),
    hint: 'Check with screenshot (front and left). Fix single joints with set_bones; edit_history undo restores the previous joints.'
  }
}

// ---------------------------------------------------------------------------

const api = {
  set_render_loop,
  status,
  catalog,
  get_counters,
  wait_for_counter,
  load_builtin_model,
  transform_model,
  select_skeleton,
  confirm_skeleton,
  get_bones,
  set_bone_transforms,
  edit_history,
  set_skinning_options,
  bind_skin,
  go_back_to_step,
  list_animations,
  play_animation,
  set_animation_options,
  set_props,
  export_model,
  capture,
  animation_sheet,
  analyze_model,
  auto_place_joints
}

declare global {
  interface Window { m2m: typeof api, m2m_ready: boolean }
}

window.m2m = api
window.m2m_ready = true
