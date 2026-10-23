// Automatic joint placement for the human rig on a T-pose mesh.
//
// The surface is sampled evenly and cut into thin cross-sections: horizontal
// slices for the legs, torso and neck, vertical slabs along each arm. Body
// landmarks come from where those sections split (crotch), meet the torso
// (armpits), narrow (knees, elbows, wrists, neck) or widen into the foot
// (ankles). The remaining joints sit between landmarks with the proportions of
// the rig itself (spine spacing, fingers). Plain math with no three.js, so the
// bridge and Node tests run the same code.

export type Vec3 = [number, number, number]

/** A body point from a front view: [x, y] or [x, y, z]; without z the depth comes from the mesh */
export type MarkerPoint = number[]

export interface BodyMarkers {
  chin?: MarkerPoint
  groin?: MarkerPoint
  left_wrist?: MarkerPoint
  right_wrist?: MarkerPoint
  left_elbow?: MarkerPoint
  right_elbow?: MarkerPoint
  left_knee?: MarkerPoint
  right_knee?: MarkerPoint
}

export interface TemplateJoint { name: string, parent: string | null, world: Vec3 }

export interface JointFitInput {
  /** World-space triangles, 9 floats each (Y up, character faces +Z, its left side is +X) */
  triangles: Float32Array
  /** The skeleton as it is now: gives the rig's proportions (spine spacing, fingers) */
  template: TemplateJoint[]
  markers?: BodyMarkers
  /** Average the two sides into a mirror-symmetric skeleton (default true) */
  symmetric?: boolean
  samples?: number
}

export type LandmarkSource = 'detected' | 'fallback' | 'marker'

export interface JointFitResult {
  joints: Record<string, Vec3>
  landmarks: Record<string, Vec3>
  sources: Record<string, LandmarkSource>
  confidence: number
  notes: string[]
  head_correction_height: number
}

// Tuned on the human variants that ship with Mesh2Motion (rigged by hand) plus
// two generated characters; lengths are fractions of the model height.
export const FIT_CONSTANTS = {
  shoulder_out: -0.008,
  shoulder_section: 0.02,
  shoulder_z: 0.005,
  wrist_range: [0.55, 0.88],
  wrist_out: 0.007,
  elbow_range: [0.3, 0.72],
  elbow_significance: 0.95,
  thigh_ratio: 0.648,
  thigh_above_crotch: 0.03,
  thigh_probe: 0.02,
  thigh_z: -0.009,
  crotch_ratio_min: 0.45,
  crotch_ratio: 0.59,
  pelvis_up: -0.009,
  pelvis_depth: 0.345,
  knee_range: [0.42, 0.68],
  knee_significance: 0.97,
  knee_fallback: 0.553,
  knee_z: 0.007,
  dip_tolerance: 0.03,
  ankle_threshold: 0.3,
  ankle_up: 0.01,
  ankle_z: -0.012,
  ankle_fallback: 0.055,
  foot_band: 0.035,
  ball: 0.7,
  ball_y: 0.009,
  ball_leaf_in: 0.0,
  ball_leaf_y: 0.007,
  neck_range: 0.42,
  neck_check_range: 0.65,
  neck_fallback: 0.25,
  head_up: 0.004,
  head_z: 0.01,
  head_leaf_down: 0.0,
  neck_k: 0.23,
  neck_depth: 0.42,
  spine_depth: [0.4, 0.43, 0.48],
  clavicle_x: 0.01,
  clavicle_y: -0.011,
  clavicle_depth: 0.79,
  finger_inset: 0.15,
  max_arm_droop_deg: 30
}

const K = FIT_CONSTANTS

// ---------------------------------------------------------------------------
// Point cloud
// ---------------------------------------------------------------------------

type Axis = 0 | 1 | 2

interface Section {
  n: number
  min: Vec3
  max: Vec3
}

const mid = (s: Section, axis: Axis): number => (s.min[axis] + s.max[axis]) / 2
const extent = (s: Section, axis: Axis): number => s.max[axis] - s.min[axis]

function mulberry32 (seed: number): () => number {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

class Cloud {
  readonly p: Float32Array[]
  readonly count: number
  private readonly order: Uint32Array[] = []
  private readonly sorted: Float32Array[] = []

  // Area-weighted samples, so dense and sparse parts of the mesh weigh the same
  constructor (triangles: Float32Array, samples: number) {
    const triangle_count = Math.floor(triangles.length / 9)
    if (triangle_count === 0) throw new Error('The model has no triangles')
    const cumulative = new Float64Array(triangle_count)
    let total = 0
    for (let t = 0; t < triangle_count; t++) {
      const o = t * 9
      const ax = triangles[o + 3] - triangles[o]; const ay = triangles[o + 4] - triangles[o + 1]; const az = triangles[o + 5] - triangles[o + 2]
      const bx = triangles[o + 6] - triangles[o]; const by = triangles[o + 7] - triangles[o + 1]; const bz = triangles[o + 8] - triangles[o + 2]
      total += Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) / 2
      cumulative[t] = total
    }
    if (!(total > 0)) throw new Error('The model has no surface area')

    this.count = samples
    this.p = [new Float32Array(samples), new Float32Array(samples), new Float32Array(samples)]
    const random = mulberry32(12345)
    for (let i = 0; i < samples; i++) {
      const target = random() * total
      let lo = 0
      let hi = triangle_count - 1
      while (lo < hi) {
        const m = (lo + hi) >> 1
        if (cumulative[m] < target) lo = m + 1
        else hi = m
      }
      let u = random()
      let v = random()
      if (u + v > 1) { u = 1 - u; v = 1 - v }
      const o = lo * 9
      for (let a = 0; a < 3; a++) {
        this.p[a][i] = triangles[o + a] + u * (triangles[o + 3 + a] - triangles[o + a]) + v * (triangles[o + 6 + a] - triangles[o + a])
      }
    }

    for (let a = 0; a < 3; a++) {
      const values = this.p[a]
      const order = new Uint32Array(samples)
      for (let i = 0; i < samples; i++) order[i] = i
      order.sort((i, j) => values[i] - values[j])
      this.order.push(order)
      this.sorted.push(Float32Array.from(order, i => values[i]))
    }
  }

  private lower_bound (axis: Axis, value: number): number {
    const sorted = this.sorted[axis]
    let lo = 0
    let hi = sorted.length
    while (lo < hi) {
      const m = (lo + hi) >> 1
      if (sorted[m] < value) lo = m + 1
      else hi = m
    }
    return lo
  }

  /** Indices of the points with lo <= value < hi along an axis */
  band (axis: Axis, lo: number, hi: number): Uint32Array {
    return this.order[axis].subarray(this.lower_bound(axis, lo), this.lower_bound(axis, hi))
  }

  bounds (): Section {
    return { n: this.count, min: [0, 1, 2].map(a => this.sorted[a][0]) as Vec3, max: [0, 1, 2].map(a => this.sorted[a][this.count - 1]) as Vec3 }
  }

  section (indices: ArrayLike<number>): Section {
    const min: Vec3 = [Infinity, Infinity, Infinity]
    const max: Vec3 = [-Infinity, -Infinity, -Infinity]
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k]
      for (let a = 0; a < 3; a++) {
        const value = this.p[a][i]
        if (value < min[a]) min[a] = value
        if (value > max[a]) max[a] = value
      }
    }
    return { n: indices.length, min, max }
  }

  /** Splits the points into solid spans along an axis wherever a gap is wider than `gap` */
  islands (indices: ArrayLike<number>, axis: Axis, gap: number, min_count = 3): Section[] {
    const values = this.p[axis]
    const list = Array.from(indices).sort((i, j) => values[i] - values[j])
    const result: Section[] = []
    let start = 0
    for (let k = 1; k <= list.length; k++) {
      if (k === list.length || values[list[k]] - values[list[k - 1]] > gap) {
        if (k - start >= min_count) result.push(this.section(list.slice(start, k)))
        start = k
      }
    }
    return result
  }

  filter (indices: ArrayLike<number>, keep: (i: number) => boolean): number[] {
    const result: number[] = []
    for (let k = 0; k < indices.length; k++) if (keep(indices[k])) result.push(indices[k])
    return result
  }
}

function median (values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length === 0 ? NaN : sorted[Math.floor(sorted.length / 2)]
}

function smooth (values: number[]): number[] {
  return values.map((_, i) => {
    const window = values.slice(Math.max(0, i - 1), i + 2)
    return window.reduce((a, b) => a + b, 0) / window.length
  })
}

/** Index of the smallest value in [from, to] and whether it is a real dip (lower than the peaks on both sides) */
function find_dip (values: number[], from: number, to: number, outer_from: number, outer_to: number, significance: number): { index: number, significant: boolean } {
  let index = -1
  for (let i = Math.max(0, from); i <= Math.min(values.length - 1, to); i++) {
    if (index === -1 || values[i] < values[index]) index = i
  }
  if (index === -1) return { index: -1, significant: false }
  let before = -Infinity
  let after = -Infinity
  for (let i = Math.max(0, outer_from); i < index; i++) before = Math.max(before, values[i])
  for (let i = index + 1; i <= Math.min(values.length - 1, outer_to); i++) after = Math.max(after, values[i])
  return { index, significant: values[index] < significance * Math.min(before, after) }
}

// Where a profile is flat, any point of the plateau is as narrow as the minimum:
// take the one nearest to where the rig's proportions put the joint
function nearest_to_prior (values: number[], from: number, to: number, minimum: number, prior: number): number {
  let best = -1
  for (let i = Math.max(0, from); i <= Math.min(values.length - 1, to); i++) {
    if (values[i] > minimum * (1 + K.dip_tolerance)) continue
    if (best === -1 || Math.abs(i - prior) < Math.abs(best - prior)) best = i
  }
  return best
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

// ---------------------------------------------------------------------------
// Fitting
// ---------------------------------------------------------------------------

interface ArmSample { x: number, s: Section }
interface LegSample { y: number, s: Section }

export function fit_human_joints (input: JointFitInput): JointFitResult {
  const template = new Map(input.template.map(joint => [joint.name, joint]))
  for (const name of ['pelvis', 'spine_01', 'neck_01', 'head', 'clavicle_l', 'upperarm_l', 'lowerarm_l', 'hand_l', 'thigh_l', 'calf_l', 'foot_l']) {
    if (!template.has(name)) throw new Error(`auto placement needs the human rig; bone "${name}" is missing`)
  }

  const cloud = new Cloud(input.triangles, Math.max(20000, Math.round(input.samples ?? 160000)))
  const box = cloud.bounds()
  const height = box.max[1] - box.min[1]
  const floor = box.min[1]
  const width = box.max[0] - box.min[0]
  const depth = box.max[2] - box.min[2]
  const at = (fraction: number): number => floor + fraction * height
  const notes: string[] = []
  const sources: Record<string, LandmarkSource> = {}
  const landmarks: Record<string, Vec3> = {}
  const markers = input.markers ?? {}
  const symmetric = input.symmetric ?? true

  if (depth > 0.6 * height || depth > width) {
    throw new Error(`The model is ${depth.toFixed(3)} deep for ${height.toFixed(3)} tall and ${width.toFixed(3)} wide: it must stand up on +Y and face +Z (use transform_model rotate).`)
  }

  const slice = height / 200
  const gap = height * 0.008

  // body midline at the waist, below the arms and above the legs
  const widest = (lo: number, hi: number): Section | null => {
    const spans = cloud.islands(cloud.band(1, lo, hi), 0, gap)
    return spans.length === 0 ? null : spans.reduce((a, b) => (b.n > a.n ? b : a))
  }
  const centers: number[] = []
  for (let y = at(0.56); y < at(0.66); y += slice * 2) {
    const span = widest(y, y + slice)
    if (span !== null) centers.push(mid(span, 0))
  }
  if (centers.length === 0) throw new Error('No torso found between 56% and 66% of the height')
  const cx = median(centers)

  // a marker given on one side only stands for both sides of a symmetric skeleton
  const side_marker = (left: MarkerPoint | undefined, right: MarkerPoint | undefined, side: 1 | -1): MarkerPoint | undefined => {
    const own = side > 0 ? left : right
    const other = side > 0 ? right : left
    if (own !== undefined || !symmetric || other === undefined) return own
    return [2 * cx - other[0], ...other.slice(1)]
  }

  // the island that contains (or is nearest to) the midline in a horizontal slice
  const central = (lo: number, hi: number, gap_size = gap): Section | null => {
    const spans = cloud.islands(cloud.band(1, lo, hi), 0, gap_size)
    if (spans.length === 0) return null
    const distance = (s: Section): number => (cx < s.min[0] ? s.min[0] - cx : cx > s.max[0] ? cx - s.max[0] : 0)
    return spans.reduce((a, b) => (distance(b) < distance(a) ? b : a))
  }

  // ---- arms: follow each arm from the fingertips in, until it merges into the torso
  const dx = height / 250
  const arm_floor = at(0.3)
  const slab_spans = (x: number): Section[] =>
    cloud.islands(cloud.filter(cloud.band(0, x - dx / 2, x + dx / 2), i => cloud.p[1][i] > arm_floor), 1, height * 0.012)
  const follow = (spans: Section[], previous: [number, number]): Section | null => {
    let best: Section | null = null
    let best_overlap = -height * 0.02
    for (const span of spans) {
      const overlap = Math.min(previous[1], span.max[1]) - Math.max(previous[0], span.min[1])
      if (overlap > best_overlap) { best = span; best_overlap = overlap }
    }
    return best
  }

  const trace_from_tip = (side: 1 | -1): ArmSample[] => {
    const label = side > 0 ? 'left' : 'right'
    const tip = side > 0 ? box.max[0] : box.min[0]
    if (Math.abs(tip - cx) < 0.25 * height) {
      throw new Error(`The ${label} arm does not reach out to the side: auto placement needs a T-pose (arms straight out). Mesh2Motion animations also expect a T-pose.`)
    }
    const samples: ArmSample[] = []
    for (let x = tip - side * dx / 2; side * (x - cx) > 0; x -= side * dx) {
      const candidates = slab_spans(x)
      const previous = samples[samples.length - 1]?.s
      const span = previous === undefined
        ? candidates.reduce<Section | null>((a, b) => (a === null || b.n > a.n ? b : a), null)
        : follow(candidates, [previous.min[1], previous.max[1]])
      if (span === null) break
      // a slab as tall as this cuts through the torso, not an arm
      if (extent(span, 1) > 0.22 * height) break
      samples.push({ x, s: span })
    }
    if (samples.length < 20) throw new Error(`The ${label} arm could not be followed in from the fingertips; is the model in a T-pose?`)
    return samples
  }
  const traces = { 1: trace_from_tip(1), [-1]: trace_from_tip(-1) }

  // the upper arm, between the elbow and where the arm merged into the torso
  const upper_arm = (side: 1 | -1): Section[] => {
    const samples = traces[side]
    return samples.slice(Math.floor(samples.length * 0.6), Math.floor(samples.length * 0.85)).map(sample => sample.s)
  }
  const shoulder_top = Math.max(...[1, -1].map(side => median(upper_arm(side as 1 | -1).map(s => s.max[1]))))

  // following the arm inwards, the armpit is where its underside drops away into the side of the torso
  const find_armpit = (side: 1 | -1): { x: number, y: number } => {
    const samples = traces[side]
    const bottom = median(upper_arm(side).map(s => s.min[1]))
    for (let i = Math.floor(samples.length * 0.6); i < samples.length; i++) {
      if (samples[i].s.min[1] < bottom - 0.015 * height) return { x: samples[i].x, y: bottom }
    }
    return { x: samples[samples.length - 1].x - side * dx, y: bottom }
  }
  const armpits = { 1: find_armpit(1), [-1]: find_armpit(-1) }
  const armpit_y = Math.min(armpits[1].y, armpits[-1].y)

  // the arm from the armpit out to the fingertips
  const trace_arm = (side: 1 | -1): ArmSample[] =>
    traces[side].filter(sample => side * (sample.x - armpits[side].x) > 0).reverse()

  interface ArmFit { shoulder: Vec3, elbow: Vec3, wrist: Vec3, tip: number, samples: ArmSample[], droop: number }
  const fit_arm = (side: 1 | -1): ArmFit => {
    const label = side > 0 ? 'left' : 'right'
    const samples = trace_arm(side)
    if (samples.length < 20) throw new Error(`The ${label} arm could not be followed from the armpit outwards; is the model in a T-pose?`)
    const armpit_x = samples[0].x - side * dx / 2
    landmarks[`${label}_armpit`] = [armpit_x, armpits[side].y, mid(samples[0].s, 2)]
    const tip = samples[samples.length - 1].x + side * dx / 2
    const along = (x: number): number => Math.abs(x - armpit_x) / Math.abs(tip - armpit_x)
    const at_x = (x: number): Section => samples.reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a)).s
    const center = (x: number): Vec3 => { const s = at_x(x); return [x, mid(s, 1), mid(s, 2)] }

    const shoulder_x = armpit_x + side * K.shoulder_out * height
    const shoulder_section = at_x(armpit_x + side * K.shoulder_section * height)
    const shoulder: Vec3 = [shoulder_x, mid(shoulder_section, 1), mid(shoulder_section, 2) + K.shoulder_z * height]

    // wrist: narrowest section (front to back) before the palm widens
    const area = smooth(samples.map(sample => extent(sample.s, 2)))
    const index_of = (fraction: number): number => samples.findIndex(sample => along(sample.x) >= fraction)
    let wrist: Vec3
    const wrist_marker = side_marker(markers.left_wrist, markers.right_wrist, side)
    if (wrist_marker !== undefined) {
      wrist = marker_point(wrist_marker, center(wrist_marker[0]))
      sources[`${label}_wrist`] = 'marker'
    } else {
      const dip = find_dip(area, index_of(K.wrist_range[0]), index_of(K.wrist_range[1]), 0, samples.length - 1, 1)
      if (dip.index !== -1) {
        wrist = center(samples[dip.index].x + side * K.wrist_out * height)
        sources[`${label}_wrist`] = 'detected'
      } else {
        wrist = center(lerp(armpit_x, tip, 0.75))
        sources[`${label}_wrist`] = 'fallback'
      }
    }

    // elbow: narrowing between the biceps and the forearm muscles
    let elbow: Vec3
    const elbow_marker = side_marker(markers.left_elbow, markers.right_elbow, side)
    if (elbow_marker !== undefined) {
      elbow = marker_point(elbow_marker, center(elbow_marker[0]))
      sources[`${label}_elbow`] = 'marker'
    } else {
      const span = Math.abs(wrist[0] - shoulder_x)
      const index_to = (fraction: number): number => samples.findIndex(sample => Math.abs(sample.x - shoulder_x) >= fraction * span)
      const girth = smooth(samples.map(sample => extent(sample.s, 1) + extent(sample.s, 2)))
      const t_shoulder = template.get('upperarm_l')!.world[0]
      const ratio = (template.get('lowerarm_l')!.world[0] - t_shoulder) / (template.get('hand_l')!.world[0] - t_shoulder)
      const dip = find_dip(girth, index_to(K.elbow_range[0]), index_to(K.elbow_range[1]), index_to(0.15), index_to(0.9), K.elbow_significance)
      if (dip.index !== -1 && dip.significant) {
        const index = nearest_to_prior(girth, index_to(K.elbow_range[0]), index_to(K.elbow_range[1]), girth[dip.index], index_to(ratio))
        elbow = center(samples[index].x)
        sources[`${label}_elbow`] = 'detected'
      } else {
        elbow = center(shoulder_x + ratio * (wrist[0] - shoulder_x))
        sources[`${label}_elbow`] = 'fallback'
      }
    }

    const droop = Math.atan2(shoulder[1] - wrist[1], Math.abs(wrist[0] - shoulder[0])) * 180 / Math.PI
    return { shoulder, elbow, wrist, tip, samples, droop }
  }

  const left_arm = fit_arm(1)
  const right_arm = fit_arm(-1)
  const droop = Math.max(left_arm.droop, right_arm.droop)
  if (droop > K.max_arm_droop_deg) {
    throw new Error(`The arms point ${Math.round(droop)}° below horizontal: auto placement needs a T-pose (Mesh2Motion animations expect one too).`)
  }
  if (droop > 15) notes.push(`arms droop ${Math.round(droop)}° below horizontal; animations will lift them to a T-pose`)

  // hips sit at a steady fraction of the shoulder height, and above the crotch
  const shoulder_height = (left_arm.shoulder[1] + right_arm.shoulder[1]) / 2 - floor

  // ---- crotch: going down from the waist, the first slice with a gap at the midline
  let crotch_y = NaN
  const groin = markers.groin
  if (groin !== undefined) {
    crotch_y = groin[1]
    sources.crotch = 'marker'
  } else {
    let gaps = 0
    for (let y = Math.min(armpit_y, at(0.65)) - slice; y > at(0.15); y -= slice) {
      const span = central(y, y + slice, height * 0.006)
      if (span !== null && span.min[0] <= cx && span.max[0] >= cx) {
        gaps = 0
        continue
      }
      if (++gaps === 2) { crotch_y = y + 2 * slice; break }
    }
    if (Number.isNaN(crotch_y) || crotch_y - floor < K.crotch_ratio_min * shoulder_height) {
      if (!Number.isNaN(crotch_y)) notes.push(`legs are joined down to y=${crotch_y.toFixed(3)} (robe or coat?); crotch estimated from the shoulder height`)
      else notes.push('no gap between the legs; crotch estimated from the shoulder height')
      crotch_y = floor + K.crotch_ratio * shoulder_height
      sources.crotch = 'fallback'
    } else {
      sources.crotch = 'detected'
    }
  }
  landmarks.crotch = [groin?.[0] ?? cx, crotch_y, groin?.[2] ?? 0]
  const thigh_y = Math.max(floor + K.thigh_ratio * shoulder_height, crotch_y + K.thigh_above_crotch * height)

  // ---- legs: horizontal slices from the crotch down to the floor
  const trace_leg = (side: 1 | -1): LegSample[] => {
    const samples: LegSample[] = []
    let previous: [number, number] | null = null
    for (let y = crotch_y - slice; y >= floor; y -= slice) {
      const points = cloud.filter(cloud.band(1, y, y + slice), i => side * (cloud.p[0][i] - cx) > 0)
      const spans = cloud.islands(points, 0, gap)
      if (spans.length === 0) continue
      let best = spans[0]
      if (previous === null) {
        best = spans.reduce((a, b) => (b.n > a.n ? b : a))
      } else {
        const prev = previous
        const overlap = (s: Section): number => Math.min(prev[1], s.max[0]) - Math.max(prev[0], s.min[0])
        best = spans.reduce((a, b) => (overlap(b) > overlap(a) ? b : a))
      }
      samples.push({ y, s: best })
      previous = [best.min[0], best.max[0]]
    }
    return samples
  }

  interface LegFit { thigh: Vec3, knee: Vec3, ankle: Vec3, ball: Vec3, ball_leaf: Vec3, toe: number, heel: number }
  const fit_leg = (side: 1 | -1): LegFit => {
    const label = side > 0 ? 'left' : 'right'
    const samples = trace_leg(side)
    if (samples.length < 20) throw new Error(`The ${label} leg could not be followed down from the crotch`)
    const at_y = (y: number): Section => samples.reduce((a, b) => (Math.abs(b.y - y) < Math.abs(a.y - y) ? b : a)).s
    const center = (y: number): Vec3 => { const s = at_y(y); return [mid(s, 0), y, mid(s, 2)] }

    const thigh_section = at_y(crotch_y - K.thigh_probe * height)
    const thigh: Vec3 = [mid(thigh_section, 0), thigh_y, mid(thigh_section, 2) + K.thigh_z * height]

    // knee: narrowest leg section between the thigh and the calf muscles
    let knee: Vec3
    const knee_center = (y: number): Vec3 => { const c = center(y); return [c[0], c[1], c[2] + K.knee_z * height] }
    const knee_marker = side_marker(markers.left_knee, markers.right_knee, side)
    if (knee_marker !== undefined) {
      knee = marker_point(knee_marker, knee_center(knee_marker[1]))
      sources[`${label}_knee`] = 'marker'
    } else {
      const girth = smooth(samples.map(sample => extent(sample.s, 0) + extent(sample.s, 2)))
      const index_at = (fraction: number): number => {
        const y = lerp(floor, thigh_y, fraction)
        return samples.findIndex(sample => sample.y <= y)
      }
      // samples run from the crotch down, so the higher fraction comes first
      const dip = find_dip(girth, index_at(K.knee_range[1]), index_at(K.knee_range[0]), index_at(0.85), index_at(0.25), K.knee_significance)
      if (dip.index !== -1 && dip.significant) {
        const index = nearest_to_prior(girth, index_at(K.knee_range[1]), index_at(K.knee_range[0]), girth[dip.index], index_at(K.knee_fallback))
        knee = knee_center(samples[index].y)
        sources[`${label}_knee`] = 'detected'
      } else {
        knee = knee_center(lerp(floor, thigh[1], K.knee_fallback))
        sources[`${label}_knee`] = 'fallback'
      }
    }

    // foot: heel and toe from the lowest slices on this side
    const foot_points = cloud.filter(cloud.band(1, floor, at(K.foot_band)), i => side * (cloud.p[0][i] - cx) > 0)
    const foot_z = foot_points.map(i => cloud.p[2][i]).sort((a, b) => a - b)
    const heel = foot_z[Math.floor(foot_z.length * 0.005)]
    const toe = foot_z[Math.floor(foot_z.length * 0.995)]
    const foot_length = toe - heel
    const mean_x = (keep: (z: number) => boolean): number => {
      const xs = foot_points.filter(i => keep(cloud.p[2][i])).map(i => cloud.p[0][i])
      return xs.length === 0 ? knee[0] : xs.reduce((a, b) => a + b, 0) / xs.length
    }

    // ankle: just above where the front of the leg flares out into the foot
    const front = samples.filter(sample => sample.y < at(0.16)).map(sample => ({ y: sample.y, z: sample.s.max[2] }))
    const shin_front = Math.min(...front.filter(f => f.y >= at(0.05)).map(f => f.z))
    const toe_front = Math.max(...front.filter(f => f.y < at(0.04)).map(f => f.z))
    let ankle_y = at(K.ankle_fallback)
    if (toe_front - shin_front > 0.02 * height) {
      const threshold = shin_front + K.ankle_threshold * (toe_front - shin_front)
      const flared = front.filter(f => f.y < at(0.12) && f.z >= threshold)
      if (flared.length > 0) {
        ankle_y = Math.max(...flared.map(f => f.y)) + slice / 2 + K.ankle_up * height
        sources[`${label}_ankle`] = 'detected'
      }
    }
    sources[`${label}_ankle`] ??= 'fallback'
    const shin = center(ankle_y + 0.015 * height)
    const ankle: Vec3 = [shin[0], ankle_y, shin[2] + K.ankle_z * height]

    const ball_z = heel + K.ball * foot_length
    const ball: Vec3 = [mean_x(z => Math.abs(z - ball_z) < 0.08 * foot_length), at(K.ball_y), ball_z]
    const leaf_z = toe - K.ball_leaf_in * foot_length
    const ball_leaf: Vec3 = [mean_x(z => z > toe - 0.12 * foot_length), at(K.ball_leaf_y), leaf_z]
    return { thigh, knee, ankle, ball, ball_leaf, toe, heel }
  }

  const left_leg = fit_leg(1)
  const right_leg = fit_leg(-1)
  const toe_reach = (left_leg.toe + right_leg.toe) / 2 - (left_leg.ankle[2] + right_leg.ankle[2]) / 2
  const heel_reach = (left_leg.ankle[2] + right_leg.ankle[2]) / 2 - (left_leg.heel + right_leg.heel) / 2
  if (heel_reach > 1.5 * toe_reach && toe_reach + heel_reach > 0.06 * height) {
    throw new Error('The feet point towards -Z: the model faces backwards. Rotate it 180° around Y with transform_model.')
  }

  // ---- neck and head: narrowest section between the shoulders and the top
  const head_top = box.max[1]
  let head_y: number
  let neck_section: Section | null = null
  if (markers.chin !== undefined) {
    head_y = markers.chin[1]
    neck_section = central(head_y - slice, head_y)
    sources.neck = 'marker'
  } else {
    const rows: Array<{ y: number, s: Section }> = []
    for (let y = shoulder_top; y < lerp(shoulder_top, head_top, K.neck_check_range); y += slice) {
      const s = central(y, y + slice)
      if (s !== null) rows.push({ y: y + slice / 2, s })
    }
    if (rows.length === 0) throw new Error('No neck found above the shoulders')
    // the neck is narrower than the shoulders below it and the head above it
    const area = smooth(rows.map(row => extent(row.s, 0) * extent(row.s, 2)))
    const last = rows.findIndex(row => row.y > lerp(shoulder_top, head_top, K.neck_range))
    const dip = find_dip(area, 0, last === -1 ? rows.length - 1 : last, 0, rows.length - 1, 1 / 1.15)
    if (dip.significant) {
      neck_section = rows[dip.index].s
      head_y = rows[dip.index].y + K.head_up * height
      sources.neck = 'detected'
    } else {
      head_y = lerp(shoulder_top, head_top, K.neck_fallback)
      neck_section = central(head_y - slice, head_y + slice)
      sources.neck = 'fallback'
    }
  }
  const head_z = neck_section !== null ? mid(neck_section, 2) + K.head_z * height : 0
  landmarks.neck = [cx, head_y, head_z]

  // ---- assemble: per-side joints, averaged into a mirror-symmetric pair unless asked not to
  const pair = (left: Vec3, right: Vec3): [Vec3, Vec3] => {
    if (!symmetric) return [left, right]
    const l: Vec3 = [(left[0] - cx + cx - right[0]) / 2 + cx, (left[1] + right[1]) / 2, (left[2] + right[2]) / 2]
    return [l, [2 * cx - l[0], l[1], l[2]]]
  }
  const joints: Record<string, Vec3> = {}
  const set_pair = (base: string, left: Vec3, right: Vec3): void => {
    const [l, r] = pair(left, right)
    joints[`${base}_l`] = l
    joints[`${base}_r`] = r
  }
  const set_center = (name: string, value: Vec3): void => { if (template.has(name)) joints[name] = value }

  // torso depth at a height: back side + fraction of the depth
  const torso_z = (y: number, fraction: number): number => {
    const s = central(y - slice, y + slice)
    return s === null ? 0 : s.min[2] + fraction * extent(s, 2)
  }

  set_pair('thigh', left_leg.thigh, right_leg.thigh)
  set_pair('calf', left_leg.knee, right_leg.knee)
  set_pair('foot', left_leg.ankle, right_leg.ankle)
  set_pair('ball', left_leg.ball, right_leg.ball)
  set_pair('ball_leaf', left_leg.ball_leaf, right_leg.ball_leaf)
  set_pair('upperarm', left_arm.shoulder, right_arm.shoulder)
  set_pair('lowerarm', left_arm.elbow, right_arm.elbow)
  set_pair('hand', left_arm.wrist, right_arm.wrist)

  const pelvis_y = joints.thigh_l[1] + K.pelvis_up * height
  set_center('pelvis', [cx, pelvis_y, torso_z(pelvis_y, K.pelvis_depth)])

  const shoulder_y = joints.upperarm_l[1]
  const neck_y = lerp(shoulder_y, head_y, K.neck_k)
  set_center('neck_01', [cx, neck_y, torso_z(neck_y, K.neck_depth)])
  set_center('head', [cx, head_y, head_z])
  set_center('head_leaf', [cx, head_top - K.head_leaf_down * height, head_z])

  // spine joints keep the rig's spacing between pelvis and neck
  const t_pelvis = template.get('pelvis')!.world[1]
  const t_neck = template.get('neck_01')!.world[1]
  ;['spine_01', 'spine_02', 'spine_03'].forEach((name, i) => {
    const joint = template.get(name)
    if (joint === undefined) return
    const y = lerp(pelvis_y, neck_y, (joint.world[1] - t_pelvis) / (t_neck - t_pelvis))
    joints[name] = [cx, y, torso_z(y, K.spine_depth[i])]
  })

  const clavicle_y = shoulder_y + K.clavicle_y * height
  const clavicle_z = torso_z(clavicle_y, K.clavicle_depth)
  joints.clavicle_l = [cx + K.clavicle_x * height, clavicle_y, clavicle_z]
  joints.clavicle_r = [cx - K.clavicle_x * height, clavicle_y, clavicle_z]

  place_hand(1)
  place_hand(-1)

  // fingers follow the rig's hand, scaled to the measured hand length and width
  function place_hand (side: 1 | -1): void {
    const suffix = side > 0 ? '_l' : '_r'
    const arm = side > 0 ? left_arm : right_arm
    const t_hand = template.get('hand_l')!.world
    const fingers = descendants('hand_l')
    if (fingers.length === 0) return
    const wrist = joints[`hand${suffix}`]
    const tip = symmetric ? cx + side * ((left_arm.tip - cx) - (right_arm.tip - cx)) / 2 : arm.tip
    const t_length = Math.max(...fingers.map(name => template.get(name)!.world[0] - t_hand[0]))
    const scale = Math.abs(tip - wrist[0]) / t_length

    const at_x = (x: number): Section => arm.samples.reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a)).s
    const index_base = template.get('index_01_l')?.world
    const pinky_base = template.get('pinky_01_l')?.world
    let z_center = wrist[2]
    let z_scale = scale
    let t_center = t_hand[2]
    if (index_base !== undefined && pinky_base !== undefined) {
      const knuckles = at_x(wrist[0] + side * (index_base[0] - t_hand[0]) * scale)
      const palm = extent(knuckles, 2) * (1 - 2 * K.finger_inset)
      z_center = mid(knuckles, 2)
      t_center = (index_base[2] + pinky_base[2]) / 2
      z_scale = palm / Math.max(1e-6, index_base[2] - pinky_base[2])
    }

    for (const name of fingers) {
      const t = template.get(name)!.world
      const x = wrist[0] + side * (t[0] - t_hand[0]) * scale
      const s = at_x(x)
      const y = Math.min(s.max[1], Math.max(s.min[1], mid(s, 1) + (t[1] - t_hand[1]) * scale))
      const z = Math.min(s.max[2], Math.max(s.min[2], z_center + (t[2] - t_center) * z_scale))
      joints[name.replace(/_l$/, suffix)] = [x, y, z]
    }
  }

  function descendants (root: string): string[] {
    const result: string[] = []
    const walk = (parent: string): void => {
      for (const joint of input.template) {
        if (joint.parent === parent) { result.push(joint.name); walk(joint.name) }
      }
    }
    walk(root)
    return result
  }

  // only joints the rig has
  for (const name of Object.keys(joints)) if (!template.has(name)) delete joints[name]

  const checked = Object.values(sources)
  const confidence = checked.filter(source => source !== 'fallback').length / Math.max(1, checked.length)
  for (const [name, source] of Object.entries(sources)) {
    if (source === 'fallback') notes.push(`${name.replace('_', ' ')}: no clear shape found, placed with the rig proportions`)
  }

  return {
    joints,
    landmarks,
    sources,
    confidence: Math.round(confidence * 100) / 100,
    notes,
    head_correction_height: head_y - 0.01 * height
  }
}

function marker_point (marker: MarkerPoint, mesh_center: Vec3): Vec3 {
  return [marker[0], marker[1], marker.length > 2 ? marker[2] : mesh_center[2]]
}
