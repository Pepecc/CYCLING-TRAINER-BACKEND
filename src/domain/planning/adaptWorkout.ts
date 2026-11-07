import { LoadProfile } from '../training/trainingMetrics'
import { blocksDurationSeconds, estimateBlocksTss, stepIntensity } from './plannedLoad'
import { formatDuration, formatTarget } from './formatStructure'
import {
  ENVIRONMENTS, PlanValidationError, StepTarget, WorkoutBlock, WorkoutEnvironment, WorkoutFocus,
  WorkoutStep, WorkoutVersion, parseBlocks,
} from './PlannedWorkout'

// Adaptar un entreno planificado a otro entorno (indoor / outdoor) y a los minutos disponibles (7.8).
// Determinista: misma entrada, misma salida, así la vista previa y el guardado coinciden.
//
// Orden de recorte (para mantener el objetivo de la sesión):
//   1. calentamiento (hasta 10'), 2. vuelta a la calma (hasta 5'), 3. volumen suave (Z1-Z2, hasta 5' por tramo),
//   4. repeticiones de las series y bloques continuos de calidad, hasta la mitad del trabajo de calidad.
// Si ni así cabe, no se adapta: se devuelve el mínimo de minutos para que el coach proponga otra sesión.
//
// En indoor (bici estática con pulsómetro, sin potencia): objetivos en zonas de FC y series de al menos 3',
// porque la FC tarda en estabilizarse. Las series cortas (sprints, 30/30, 1') se agrupan en series más largas
// por tiempo en zona, conservando el tiempo total de trabajo.

export interface AdaptRequest {
  environment: WorkoutEnvironment
  availableMinutes: number | null
}

export interface AdaptationResult {
  version: WorkoutVersion
  changes: string[]
  warnings: string[]
}

export class AdaptationNotPossibleError extends PlanValidationError {
  constructor(message: string, readonly minimumMinutes: number | null) {
    super(message)
  }
}

export const MIN_AVAILABLE_MINUTES = 15
export const MAX_AVAILABLE_MINUTES = 720

const ROUND_S = 30
const INDOOR_MIN_WORK_S = 180
const INDOOR_SERIES_S: Record<number, number> = { 4: 360, 5: 240 }   // duración objetivo al agrupar series
const MIN_RECOVERY_S = 120
const WARMUP_MIN_S = 600
const COOLDOWN_MIN_S = 300
const VOLUME_STEP_MIN_S = 300
const QUALITY_KEEP = 0.5          // fracción mínima del trabajo de calidad que se conserva
const TSS_INCREASE_WARNING = 1.15

// Zona de potencia de Coggan → zona de FC (Z6 y Z7 no existen en FC: van a Z5)
const POWER_TO_HR_ZONE = [1, 2, 3, 4, 5, 5, 5]

const ENV_LABEL: Record<WorkoutEnvironment, string> = { indoor: 'indoor', outdoor: 'exterior', any: 'cualquier entorno' }

// ─── Entrada ─────────────────────────────────────────────────────────────────

// Throws PlanValidationError
export function parseAdaptRequest(environment: unknown, availableMinutes: unknown): {
  environment: WorkoutEnvironment | undefined
  availableMinutes: number | null | undefined
} {
  let env: WorkoutEnvironment | undefined
  if (environment !== undefined && environment !== null && environment !== '') {
    if (typeof environment !== 'string' || !ENVIRONMENTS.includes(environment as WorkoutEnvironment)) {
      throw new PlanValidationError(`Entorno no válido: ${String(environment)} (valores: ${ENVIRONMENTS.join(', ')})`)
    }
    env = environment as WorkoutEnvironment
  }

  let minutes: number | null | undefined
  if (availableMinutes === null) minutes = null
  else if (availableMinutes !== undefined && availableMinutes !== '') {
    const n = typeof availableMinutes === 'string' ? Number(availableMinutes) : availableMinutes
    if (typeof n !== 'number' || !Number.isFinite(n) || n < MIN_AVAILABLE_MINUTES || n > MAX_AVAILABLE_MINUTES) {
      throw new PlanValidationError(
        `Los minutos disponibles deben estar entre ${MIN_AVAILABLE_MINUTES} y ${MAX_AVAILABLE_MINUTES}`
      )
    }
    minutes = Math.round(n)
  }
  return { environment: env, availableMinutes: minutes }
}

// ─── Adaptación ──────────────────────────────────────────────────────────────

// Throws PlanValidationError (incl. AdaptationNotPossibleError)
export function adaptWorkout(
  original: WorkoutVersion,
  focus: WorkoutFocus,
  request: AdaptRequest,
  profile: LoadProfile | null
): AdaptationResult {
  if (focus === 'rest') throw new PlanValidationError('Un día de descanso no se adapta')

  const changes: string[] = []
  const warnings: string[] = []
  const envChanges = request.environment !== original.environment && request.environment !== 'any'
  if (!envChanges && request.availableMinutes === null) {
    throw new PlanValidationError('No hay nada que adaptar: indica otro entorno (indoor / outdoor) o los minutos disponibles')
  }

  if (original.blocks.length === 0) {
    return adaptUnstructured(original, request, envChanges, changes)
  }

  let blocks = cloneBlocks(original.blocks)

  // 1. Entorno
  if (envChanges && request.environment === 'indoor') {
    blocks = toIndoor(blocks, focus, profile, changes, warnings)
  } else if (envChanges && request.environment === 'outdoor') {
    toOutdoor(blocks, changes)
  }

  // 2. Minutos disponibles
  if (request.availableMinutes !== null) {
    const limit = request.availableMinutes * 60
    const before = blocksDurationSeconds(blocks)
    if (before > limit) {
      blocks = fitToTime(blocks, limit, profile, changes)
      const after = blocksDurationSeconds(blocks)
      if (after > limit) {
        const minimum = Math.ceil(after / 60)
        throw new AdaptationNotPossibleError(
          `Con ${request.availableMinutes} min no cabe esta sesión sin perder su objetivo: necesita al menos ${minimum} min ` +
          `(calentamiento y vuelta a la calma mínimos y la mitad del trabajo de calidad)`,
          minimum
        )
      }
    } else if (!envChanges) {
      changes.push(`La sesión ya cabe en ${request.availableMinutes} min (dura ${Math.round(before / 60)} min): no hace falta recortarla`)
    }
  }

  // 3. Validación: mismas reglas que un entreno guardado, y comparación de carga
  blocks = mergeTrivialBlocks(blocks)
  const validated = parseBlocks(blocks)
  const durationS = blocksDurationSeconds(validated)
  const tss = estimateBlocksTss(validated, profile)
  const originalTss = estimateBlocksTss(original.blocks, profile)
  if (originalTss > 0 && tss > originalTss * TSS_INCREASE_WARNING) {
    warnings.push(
      `La versión adaptada sale con más carga estimada (${tss} frente a ${originalTss} de TSS), ` +
      'sobre todo por pasar de potencia a FC: las dos escalas no son idénticas'
    )
  }

  return {
    version: {
      environment: request.environment,
      blocks: validated,
      durationMinutes: Math.round(durationS / 60),
      plannedTss: tss,
    },
    changes,
    warnings,
  }
}

function adaptUnstructured(
  original: WorkoutVersion, request: AdaptRequest, envChanges: boolean, changes: string[]
): AdaptationResult {
  let duration = original.durationMinutes
  let tss = original.plannedTss
  if (envChanges) changes.push(`Entorno cambiado a ${ENV_LABEL[request.environment]}`)
  if (request.availableMinutes !== null && duration !== null && duration > request.availableMinutes) {
    const ratio = request.availableMinutes / duration
    changes.push(`Duración reducida de ${duration} a ${request.availableMinutes} min (sesión sin estructura)`)
    duration = request.availableMinutes
    tss = tss === null ? null : Math.round(tss * ratio)
  } else if (request.availableMinutes !== null && duration !== null && !envChanges) {
    changes.push(`La sesión ya cabe en ${request.availableMinutes} min: no hace falta recortarla`)
  }
  return {
    version: { environment: request.environment, blocks: [], durationMinutes: duration, plannedTss: tss },
    changes,
    warnings: [],
  }
}

// ─── Indoor / outdoor ────────────────────────────────────────────────────────

function toIndoor(
  blocks: WorkoutBlock[], focus: WorkoutFocus, profile: LoadProfile | null, changes: string[], warnings: string[]
): WorkoutBlock[] {
  let converted = 0
  let unknownWatts = 0
  for (const b of blocks) {
    for (const s of b.steps) {
      const next = toHrTarget(s.target, profile)
      if (next === null) {
        unknownWatts++
        s.notes = joinNotes(s.notes, `Objetivo original: ${formatTarget(s.target, profile)}`)
        s.target = { type: 'open', min: null, max: null }
      } else if (next !== s.target) {
        converted++
        s.target = next
      }
    }
  }
  if (converted > 0) changes.push('Objetivos de potencia pasados a zonas de FC (bici estática con pulsómetro)')
  if (unknownWatts > 0) {
    warnings.push(`${unknownWatts} pasos en vatios no se pueden pasar a FC sin FTP en el perfil: quedan libres, con el objetivo original en las notas`)
  }
  if (!profile?.maxHr || !profile?.restingHr) {
    warnings.push('Sin FC máxima y en reposo en el perfil las zonas de FC no se pueden traducir a ppm')
  }

  // Series cortas → series más largas por tiempo en zona
  const result: WorkoutBlock[] = []
  let regrouped = 0
  for (const b of blocks) {
    const shortHard = b.steps.some(s => isHardStep(s) && s.durationSeconds < INDOOR_MIN_WORK_S)
    if (!shortHard) {
      result.push(b)
      continue
    }
    result.push(regroupIndoor(b, profile))
    regrouped++
  }
  if (regrouped > 0) {
    changes.push(`Series de menos de ${INDOOR_MIN_WORK_S / 60}' agrupadas en series más largas por tiempo en zona de FC (mismo tiempo de trabajo)`)
    if (focus === 'sprint' || focus === 'anaerobic') {
      warnings.push('Los sprints y esfuerzos anaeróbicos no se pueden controlar por FC: en indoor se sustituyen por series en Z5, que es un estímulo distinto')
    }
  }
  return result
}

function toOutdoor(blocks: WorkoutBlock[], changes: string[]): void {
  const hasWork = blocks.some(b => b.steps.some(isHardStep))
  changes.push(
    hasWork
      ? 'En exterior se mantienen los objetivos; haz las series en un tramo llano o un puerto constante, sin cruces ni semáforos'
      : 'En exterior se mantienen los objetivos; elige un recorrido llano o con poco desnivel para no salirte de zona'
  )
}

// null = no se puede convertir (vatios sin FTP). Devuelve el mismo objeto si no cambia.
function toHrTarget(t: StepTarget, profile: LoadProfile | null): StepTarget | null {
  switch (t.type) {
    case 'power_zone':
      return { type: 'hr_zone', min: POWER_TO_HR_ZONE[t.min! - 1], max: POWER_TO_HR_ZONE[t.max! - 1] }
    case 'ftp_percent':
      return { type: 'hr_zone', min: ftpPercentToHrZone(t.min!), max: ftpPercentToHrZone(t.max!) }
    case 'power_w':
      if (!profile?.ftp) return null
      return {
        type: 'hr_zone',
        min: ftpPercentToHrZone((t.min! / profile.ftp) * 100),
        max: ftpPercentToHrZone((t.max! / profile.ftp) * 100),
      }
    case 'rpe':
      return { type: 'hr_zone', min: rpeToHrZone(t.min!), max: rpeToHrZone(t.max!) }
    default:
      return t   // hr_zone, hr_bpm, open
  }
}

function ftpPercentToHrZone(pct: number): number {
  if (pct < 56) return 1
  if (pct < 76) return 2
  if (pct < 91) return 3
  if (pct < 106) return 4
  return 5
}

function rpeToHrZone(rpe: number): number {
  if (rpe <= 3) return 1
  if (rpe <= 5) return 2
  if (rpe <= 6) return 3
  if (rpe <= 8) return 4
  return 5
}

// Zona de FC "alta" de un objetivo ya convertido (para decidir qué es trabajo de calidad)
function hrZoneOf(t: StepTarget, profile: LoadProfile | null): number | null {
  if (t.type === 'hr_zone') return t.max
  if (t.type === 'open') return null
  const i = stepIntensity(t, profile)
  if (i.kind === 'hr') return zoneFromFraction(i.hrr, [0.6, 0.7, 0.8, 0.9])
  return zoneFromFraction(i.if, [0.56, 0.76, 0.91, 1.06])
}

function zoneFromFraction(x: number, bounds: number[]): number {
  const idx = bounds.findIndex(b => x < b)
  return idx === -1 ? 5 : idx + 1
}

function isHardStep(s: WorkoutStep): boolean {
  return s.kind === 'work'
}

function regroupIndoor(b: WorkoutBlock, profile: LoadProfile | null): WorkoutBlock {
  const hard = b.steps.filter(s => s.kind !== 'recovery' && s.kind !== 'warmup' && s.kind !== 'cooldown')
  const rest = b.steps.filter(s => s.kind === 'recovery')
  const work = b.repeat * hard.reduce((a, s) => a + s.durationSeconds, 0)
  const recovery = b.repeat * rest.reduce((a, s) => a + s.durationSeconds, 0)
  const zoneWeighted = hard.reduce((a, s) => a + (hrZoneOf(s.target, profile) ?? 2) * s.durationSeconds, 0) /
    Math.max(1, hard.reduce((a, s) => a + s.durationSeconds, 0))
  const zone = Math.min(5, Math.max(1, Math.round(zoneWeighted)))
  const before = `${b.repeat > 1 ? `${b.repeat} × ` : ''}(${b.steps.map(s => `${formatDuration(s.durationSeconds)} ${formatTarget(s.target, profile)}`).join(' + ')})`

  // Short steps at moderate intensity: a single continuous step at that zone
  if (zone <= 3) {
    return {
      name: b.name,
      repeat: 1,
      steps: [{
        kind: 'steady',
        durationSeconds: roundTo(work + recovery),
        target: { type: 'hr_zone', min: zone, max: zone },
        cadenceMin: null,
        cadenceMax: null,
        notes: `Sustituye a ${before}`,
      }],
    }
  }

  const series = INDOOR_SERIES_S[zone]
  const reps = Math.max(1, Math.round(work / series))
  const workS = Math.max(INDOOR_MIN_WORK_S, roundTo(work / reps))
  const recS = recovery > 0
    ? clamp(roundTo((workS * recovery) / work), MIN_RECOVERY_S, workS)
    : (reps > 1 ? MIN_RECOVERY_S : 0)

  const steps: WorkoutStep[] = [{
    kind: 'work',
    durationSeconds: workS,
    target: { type: 'hr_zone', min: zone, max: zone },
    cadenceMin: null,
    cadenceMax: null,
    notes: `Tiempo en zona: cuenta desde que la FC entra en Z${zone}. Sustituye a ${before}`.slice(0, 300),
  }]
  if (recS > 0) {
    steps.push({ kind: 'recovery', durationSeconds: recS, target: { type: 'hr_zone', min: 1, max: 1 }, cadenceMin: null, cadenceMax: null, notes: null })
  }
  return { name: b.name, repeat: reps, steps }
}

// ─── Ajuste a los minutos disponibles ────────────────────────────────────────

type Role = 'warmup' | 'cooldown' | 'volume' | 'quality'

function stepRole(s: WorkoutStep, profile: LoadProfile | null): Role {
  if (s.kind === 'warmup') return 'warmup'
  if (s.kind === 'cooldown') return 'cooldown'
  if (s.kind === 'work') return 'quality'
  // steady / recovery: volume when easy (Z1-Z2), quality when continuous tempo or harder
  const zone = hrZoneOf(s.target, profile)
  return zone !== null && zone >= 3 ? 'quality' : 'volume'
}

function fitToTime(blocks: WorkoutBlock[], limit: number, profile: LoadProfile | null, changes: string[]): WorkoutBlock[] {
  const over = () => blocksDurationSeconds(blocks) - limit
  const startS = blocksDurationSeconds(blocks)
  const qualityBefore = qualitySeconds(blocks, profile)

  // Single steps (blocks without repeats) of a given role
  const singleSteps = (role: Role) =>
    blocks.filter(b => b.repeat === 1).flatMap(b => b.steps).filter(s => stepRole(s, profile) === role)

  // 1-3: warm-up, cool-down, easy volume
  const phases: Array<[Role, number, string]> = [
    ['warmup', WARMUP_MIN_S, 'Calentamiento'],
    ['cooldown', COOLDOWN_MIN_S, 'Vuelta a la calma'],
  ]
  const trimmed: Array<{ steps: WorkoutStep[]; originals: number[]; label: string; changeIndex: number }> = []
  for (const [role, minTotal, label] of phases) {
    if (over() <= 0) break
    const steps = singleSteps(role)
    const total = sum(steps)
    const target = Math.max(Math.min(total, minTotal), total - over())
    if (target < total) {
      const originals = steps.map(s => s.durationSeconds)
      shrinkProportionally(steps, target)
      trimmed.push({ steps, originals, label, changeIndex: changes.length })
      changes.push(`${label} recortado de ${formatDuration(total)} a ${formatDuration(sum(steps))}`)
    }
  }
  if (over() > 0) {
    const steps = singleSteps('volume')
    const total = sum(steps)
    if (steps.length > 0) {
      const floor = steps.length * VOLUME_STEP_MIN_S
      const target = Math.max(Math.min(total, floor), total - over())
      if (target < total) {
        shrinkEach(steps, total - target, VOLUME_STEP_MIN_S)
        changes.push(`Volumen suave (Z1-Z2) recortado de ${formatDuration(total)} a ${formatDuration(sum(steps))}`)
      }
    }
  }

  // 4. Quality: series repetitions first, then continuous quality steps, down to half of the quality work
  if (over() > 0) {
    const minQuality = qualityBefore * QUALITY_KEEP
    const originalReps = new Map(blocks.map(b => [b, b.repeat]))
    const repBlocks = blocks.filter(b => b.repeat > 1)
    let removed = true
    while (over() > 0 && removed) {
      removed = false
      // Block that keeps the largest share of its original repetitions; on ties the later (secondary) set first
      const candidates = [...repBlocks]
        .reverse()
        .filter(b => b.repeat > 1)
        .sort((a, b) => b.repeat / originalReps.get(b)! - a.repeat / originalReps.get(a)!)
      for (const b of candidates) {
        const repQuality = qualitySeconds([{ ...b, repeat: 1 }], profile)
        if (qualitySeconds(blocks, profile) - repQuality < minQuality) continue
        b.repeat--
        removed = true
        break
      }
    }
    for (const b of repBlocks) {
      const before = originalReps.get(b)!
      if (b.repeat !== before) changes.push(`Series: ${before} → ${b.repeat} repeticiones${b.name ? ` (${b.name})` : ''}`)
    }

    if (over() > 0) {
      const steps = singleSteps('quality')
      const total = sum(steps)
      const room = qualitySeconds(blocks, profile) - minQuality
      const cut = Math.min(over(), room, total)
      if (cut >= ROUND_S) {
        shrinkProportionally(steps, total - cut)
        changes.push(`Trabajo continuo de calidad recortado de ${formatDuration(total)} a ${formatDuration(sum(steps))}`)
      }
    }
  }

  // Removing a whole repetition can leave spare minutes: give them back to the warm-up, then the cool-down
  for (const t of trimmed) {
    const slack = floorTo(-over())
    if (slack < 60) break
    const current = sum(t.steps)
    const originalTotal = t.originals.reduce((a, b) => a + b, 0)
    const grow = Math.min(slack, originalTotal - current)
    if (grow <= 0) continue
    // Add the time step by step without exceeding each original duration
    let left = grow
    t.steps.forEach((s, i) => {
      const add = Math.min(left, t.originals[i] - s.durationSeconds)
      s.durationSeconds += add
      left -= add
    })
    const now = sum(t.steps)
    changes[t.changeIndex] = now >= originalTotal
      ? `${t.label} completo (${formatDuration(now)})`
      : `${t.label} recortado de ${formatDuration(originalTotal)} a ${formatDuration(now)}`
  }

  const endS = blocksDurationSeconds(blocks)
  if (endS < startS) changes.push(`Duración total: ${Math.round(startS / 60)} → ${Math.round(endS / 60)} min`)
  return blocks.filter(b => b.steps.some(s => s.durationSeconds > 0))
}

function qualitySeconds(blocks: WorkoutBlock[], profile: LoadProfile | null): number {
  return blocks.reduce(
    (acc, b) => acc + b.repeat * b.steps.filter(s => stepRole(s, profile) === 'quality').reduce((a, s) => a + s.durationSeconds, 0),
    0
  )
}

// Scales the steps so their total is about `target`, rounded down to 30 s (each step keeps at least 30 s)
function shrinkProportionally(steps: WorkoutStep[], target: number): void {
  const total = sum(steps)
  if (total <= 0 || target >= total) return
  const ratio = target / total
  for (const s of steps) s.durationSeconds = Math.max(ROUND_S, floorTo(s.durationSeconds * ratio))
}

// Removes `cut` seconds from the longest steps first, without going under `floor` per step
function shrinkEach(steps: WorkoutStep[], cut: number, floor: number): void {
  let remaining = cut
  const sorted = [...steps].sort((a, b) => b.durationSeconds - a.durationSeconds)
  for (const s of sorted) {
    if (remaining <= 0) break
    const room = Math.max(0, s.durationSeconds - Math.min(floor, s.durationSeconds))
    const take = Math.min(room, ceilTo(remaining))
    s.durationSeconds -= take
    remaining -= take
  }
}

// After regrouping, consecutive single blocks are left as they are; only empty ones are dropped
function mergeTrivialBlocks(blocks: WorkoutBlock[]): WorkoutBlock[] {
  return blocks
    .map(b => ({ ...b, steps: b.steps.filter(s => s.durationSeconds > 0) }))
    .filter(b => b.steps.length > 0)
}

// ─── Utilidades ──────────────────────────────────────────────────────────────

function cloneBlocks(blocks: WorkoutBlock[]): WorkoutBlock[] {
  return blocks.map(b => ({ ...b, steps: b.steps.map(s => ({ ...s, target: { ...s.target } })) }))
}

function joinNotes(a: string | null, b: string): string {
  return (a ? `${a}. ${b}` : b).slice(0, 300)
}

const sum = (steps: WorkoutStep[]): number => steps.reduce((a, s) => a + s.durationSeconds, 0)
const roundTo = (s: number): number => Math.max(ROUND_S, Math.round(s / ROUND_S) * ROUND_S)
const floorTo = (s: number): number => Math.floor(s / ROUND_S) * ROUND_S
const ceilTo = (s: number): number => Math.ceil(s / ROUND_S) * ROUND_S
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
