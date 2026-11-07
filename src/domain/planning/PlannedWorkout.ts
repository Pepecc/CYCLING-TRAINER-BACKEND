import { randomUUID } from 'crypto'
import { addDays, dayKey } from '../training/calendar'
import { LoadProfile } from '../training/trainingMetrics'
import { estimateBlocksTss, blocksDurationSeconds } from './plannedLoad'

// ─── Tipos ───────────────────────────────────────────────────────────────────

export type StepKind = 'warmup' | 'work' | 'recovery' | 'steady' | 'cooldown'

// hr_zone / power_zone: min y max son números de zona (Z1–Z5 de FC, Z1–Z7 de potencia)
// ftp_percent: % del FTP · power_w: vatios · hr_bpm: ppm · rpe: esfuerzo percibido 1–10 · open: libre
export type TargetType = 'hr_zone' | 'power_zone' | 'ftp_percent' | 'power_w' | 'hr_bpm' | 'rpe' | 'open'

export type WorkoutFocus =
  | 'recovery' | 'endurance' | 'tempo' | 'sweet_spot' | 'threshold' | 'vo2max' | 'anaerobic'
  | 'sprint' | 'technique' | 'strength' | 'test' | 'race' | 'rest' | 'other'

export type WorkoutEnvironment = 'indoor' | 'outdoor' | 'any'

// planned: pendiente · done / partial / skipped: lo fija el ciclista, el coach o (en 7.9) el enlace con Wahoo
export type PlannedStatus = 'planned' | 'done' | 'partial' | 'skipped'

export type PlanSource = 'coach' | 'user' | 'import'

export const STEP_KINDS: StepKind[] = ['warmup', 'work', 'recovery', 'steady', 'cooldown']
export const TARGET_TYPES: TargetType[] = ['hr_zone', 'power_zone', 'ftp_percent', 'power_w', 'hr_bpm', 'rpe', 'open']
export const WORKOUT_FOCUSES: WorkoutFocus[] = [
  'recovery', 'endurance', 'tempo', 'sweet_spot', 'threshold', 'vo2max', 'anaerobic',
  'sprint', 'technique', 'strength', 'test', 'race', 'rest', 'other',
]
export const ENVIRONMENTS: WorkoutEnvironment[] = ['indoor', 'outdoor', 'any']
export const PLANNED_STATUSES: PlannedStatus[] = ['planned', 'done', 'partial', 'skipped']

export interface StepTarget {
  type: TargetType
  min: number | null
  max: number | null
}

export interface WorkoutStep {
  kind: StepKind
  durationSeconds: number
  target: StepTarget
  cadenceMin: number | null
  cadenceMax: number | null
  notes: string | null
}

// Un bloque se repite `repeat` veces: 4 × (8' Z4 + 4' Z1) es un bloque con repeat 4 y dos pasos
export interface WorkoutBlock {
  name: string | null
  repeat: number
  steps: WorkoutStep[]
}

// Campos que se pueden dar al crear o editar un entreno planificado
export interface PlannedWorkoutInput {
  date?: unknown            // 'YYYY-MM-DD' en la zona horaria del ciclista
  title?: unknown
  focus?: unknown
  environment?: unknown
  description?: unknown
  blocks?: unknown          // WorkoutBlock[] (se valida)
  durationMinutes?: unknown // solo cuenta si no hay bloques
  tss?: unknown             // solo cuenta si no hay bloques
  status?: unknown
  notes?: unknown
}

export interface PlannedWorkoutProps {
  id: string
  userId: string
  date: string
  title: string
  focus: WorkoutFocus
  environment: WorkoutEnvironment
  description: string | null
  blocks: WorkoutBlock[]
  durationMinutes: number | null   // calculado de los bloques, o el indicado si no hay estructura
  plannedTss: number | null        // estimado de los bloques con el perfil, o el indicado si no hay estructura
  status: PlannedStatus
  notes: string | null
  source: PlanSource
  createdAt: string
  updatedAt: string
}

export class PlanValidationError extends Error {}
export class PlannedWorkoutNotFoundError extends Error {
  constructor() { super('Entreno planificado no encontrado') }
}

// ─── Límites ─────────────────────────────────────────────────────────────────

const TITLE_MAX = 120
const TEXT_MAX = 1000
const MAX_BLOCKS = 30
const MAX_STEPS_PER_BLOCK = 20
const MAX_REPEAT = 50
const MAX_STEP_SECONDS = 6 * 3600
const MAX_TOTAL_SECONDS = 12 * 3600
const PAST_DAYS = 366
const FUTURE_DAYS = 731

const TARGET_RANGES: Record<Exclude<TargetType, 'open'>, [number, number, string]> = {
  hr_zone:     [1, 5,    'zona de FC entre 1 y 5'],
  power_zone:  [1, 7,    'zona de potencia entre 1 y 7'],
  ftp_percent: [30, 300, '% de FTP entre 30 y 300'],
  power_w:     [20, 2000, 'vatios entre 20 y 2000'],
  hr_bpm:      [60, 230, 'FC entre 60 y 230 ppm'],
  rpe:         [1, 10,   'RPE entre 1 y 10'],
}

// ─── Entidad ─────────────────────────────────────────────────────────────────

export class PlannedWorkout implements PlannedWorkoutProps {
  readonly id: string
  readonly userId: string
  date: string
  title: string
  focus: WorkoutFocus
  environment: WorkoutEnvironment
  description: string | null
  blocks: WorkoutBlock[]
  durationMinutes: number | null
  plannedTss: number | null
  status: PlannedStatus
  notes: string | null
  readonly source: PlanSource
  readonly createdAt: string
  updatedAt: string

  constructor(props: PlannedWorkoutProps) {
    this.id = props.id
    this.userId = props.userId
    this.date = props.date
    this.title = props.title
    this.focus = props.focus
    this.environment = props.environment
    this.description = props.description
    this.blocks = props.blocks
    this.durationMinutes = props.durationMinutes
    this.plannedTss = props.plannedTss
    this.status = props.status
    this.notes = props.notes
    this.source = props.source
    this.createdAt = props.createdAt
    this.updatedAt = props.updatedAt
  }

  // Throws PlanValidationError
  static create(userId: string, input: PlannedWorkoutInput, source: PlanSource, profile: LoadProfile | null): PlannedWorkout {
    if (input.date === undefined) throw new PlanValidationError('Falta la fecha del entreno')
    if (input.title === undefined) throw new PlanValidationError('Falta el título del entreno')
    const now = new Date().toISOString()
    const workout = new PlannedWorkout({
      id: randomUUID(),
      userId,
      date: '',
      title: '',
      focus: 'other',
      environment: 'any',
      description: null,
      blocks: [],
      durationMinutes: null,
      plannedTss: null,
      status: 'planned',
      notes: null,
      source,
      createdAt: now,
      updatedAt: now,
    })
    workout.update(input, profile)
    return workout
  }

  // Partial update; undefined = keep, null or '' = clear (text fields). `blocks` replaces the whole structure.
  // Duration and TSS are recalculated from the blocks with the current profile. Throws PlanValidationError.
  update(input: PlannedWorkoutInput, profile: LoadProfile | null): void {
    const next = {
      date: input.date !== undefined ? parseDate(input.date, this.date) : this.date,
      title: input.title !== undefined ? parseTitle(input.title) : this.title,
      focus: input.focus !== undefined ? parseEnum(input.focus, WORKOUT_FOCUSES, 'Tipo de entreno') : this.focus,
      environment: input.environment !== undefined ? parseEnum(input.environment, ENVIRONMENTS, 'Entorno') : this.environment,
      description: input.description !== undefined ? parseText(input.description, 'La descripción') : this.description,
      blocks: input.blocks !== undefined ? parseBlocks(input.blocks) : this.blocks,
      status: input.status !== undefined ? parseEnum(input.status, PLANNED_STATUSES, 'Estado') : this.status,
      notes: input.notes !== undefined ? parseText(input.notes, 'Las notas') : this.notes,
    }

    let durationMinutes: number | null
    let plannedTss: number | null
    if (next.blocks.length > 0) {
      durationMinutes = Math.round(blocksDurationSeconds(next.blocks) / 60)
      plannedTss = estimateBlocksTss(next.blocks, profile)
    } else {
      // Sin estructura (descanso, fuerza, salida libre): se usan los valores indicados
      durationMinutes = input.durationMinutes !== undefined
        ? parseOptionalNumber(input.durationMinutes, 0, 720, 'La duración debe estar entre 0 y 720 minutos')
        : (this.blocks.length > 0 ? null : this.durationMinutes)
      plannedTss = input.tss !== undefined
        ? parseOptionalNumber(input.tss, 0, 1000, 'El TSS debe estar entre 0 y 1000')
        : (this.blocks.length > 0 ? null : this.plannedTss)
      if (next.focus === 'rest') {
        durationMinutes = durationMinutes ?? 0
        plannedTss = plannedTss ?? 0
      }
    }

    Object.assign(this, next, {
      durationMinutes: durationMinutes === null ? null : Math.round(durationMinutes),
      plannedTss: plannedTss === null ? null : Math.round(plannedTss),
    })
    this.updatedAt = new Date().toISOString()
  }

  // Re-estimates TSS after a profile change (FTP, FC) — only for structured workouts
  recalculateLoad(profile: LoadProfile | null): void {
    if (this.blocks.length > 0) this.plannedTss = estimateBlocksTss(this.blocks, profile)
  }
}

// ─── Validación ──────────────────────────────────────────────────────────────

function parseDate(value: unknown, current: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new PlanValidationError('La fecha debe tener el formato AAAA-MM-DD')
  }
  const d = new Date(`${value}T12:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new PlanValidationError(`Fecha no válida: ${value}`)
  }
  // Moving an existing workout keeps its date valid even if it was already far in the past
  if (value !== current) {
    const today = dayKey(new Date())
    if (value < addDays(today, -PAST_DAYS) || value > addDays(today, FUTURE_DAYS)) {
      throw new PlanValidationError('La fecha debe estar entre hace un año y dentro de dos años')
    }
  }
  return value
}

function parseTitle(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new PlanValidationError('El título no puede estar vacío')
  const t = value.trim()
  if (t.length > TITLE_MAX) throw new PlanValidationError(`El título es demasiado largo (máx. ${TITLE_MAX} caracteres)`)
  return t
}

function parseText(value: unknown, label: string, max = TEXT_MAX): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new PlanValidationError(`${label} debe ser texto`)
  const t = value.trim()
  if (t.length > max) throw new PlanValidationError(`${label} es demasiado largo (máx. ${max} caracteres)`)
  return t || null
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new PlanValidationError(`${label} no válido: ${String(value)} (valores: ${allowed.join(', ')})`)
  }
  return value as T
}

function parseNumber(value: unknown, min: number, max: number, msg: string): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw new PlanValidationError(msg)
  return n
}

function parseOptionalNumber(value: unknown, min: number, max: number, msg: string): number | null {
  if (value === null) return null
  return parseNumber(value, min, max, msg)
}

export function parseBlocks(value: unknown): WorkoutBlock[] {
  if (value === null) return []
  if (!Array.isArray(value)) throw new PlanValidationError('La estructura debe ser una lista de bloques')
  if (value.length > MAX_BLOCKS) throw new PlanValidationError(`Demasiados bloques (máx. ${MAX_BLOCKS})`)

  const blocks = value.map((raw, i) => parseBlock(raw, i + 1))
  if (blocksDurationSeconds(blocks) > MAX_TOTAL_SECONDS) {
    throw new PlanValidationError('El entreno no puede durar más de 12 horas')
  }
  return blocks
}

function parseBlock(raw: unknown, n: number): WorkoutBlock {
  if (!raw || typeof raw !== 'object') throw new PlanValidationError(`Bloque ${n}: formato no válido`)
  const b = raw as Record<string, unknown>
  const repeat = b.repeat === undefined || b.repeat === null
    ? 1
    : Math.round(parseNumber(b.repeat, 1, MAX_REPEAT, `Bloque ${n}: las repeticiones deben estar entre 1 y ${MAX_REPEAT}`))
  if (!Array.isArray(b.steps) || b.steps.length === 0) throw new PlanValidationError(`Bloque ${n}: no tiene pasos`)
  if (b.steps.length > MAX_STEPS_PER_BLOCK) {
    throw new PlanValidationError(`Bloque ${n}: demasiados pasos (máx. ${MAX_STEPS_PER_BLOCK})`)
  }
  return {
    name: b.name === undefined ? null : parseText(b.name, `Bloque ${n}: el nombre`, TITLE_MAX),
    repeat,
    steps: b.steps.map((s, i) => parseStep(s, `Bloque ${n}, paso ${i + 1}`)),
  }
}

function parseStep(raw: unknown, where: string): WorkoutStep {
  if (!raw || typeof raw !== 'object') throw new PlanValidationError(`${where}: formato no válido`)
  const s = raw as Record<string, unknown>

  const kind = parseEnum(s.kind ?? 'steady', STEP_KINDS, `${where}: tipo de paso`)
  const durationSeconds = Math.round(
    parseNumber(s.durationSeconds, 5, MAX_STEP_SECONDS, `${where}: la duración debe estar entre 5 segundos y 6 horas`)
  )

  const cadenceMin = s.cadenceMin == null ? null : Math.round(parseNumber(s.cadenceMin, 30, 160, `${where}: cadencia entre 30 y 160 rpm`))
  const cadenceMax = s.cadenceMax == null ? null : Math.round(parseNumber(s.cadenceMax, 30, 160, `${where}: cadencia entre 30 y 160 rpm`))
  if (cadenceMin !== null && cadenceMax !== null && cadenceMin > cadenceMax) {
    throw new PlanValidationError(`${where}: la cadencia mínima es mayor que la máxima`)
  }

  return {
    kind,
    durationSeconds,
    target: parseTarget(s.target, where),
    cadenceMin,
    cadenceMax,
    notes: s.notes === undefined ? null : parseText(s.notes, `${where}: las notas`, 300),
  }
}

function parseTarget(raw: unknown, where: string): StepTarget {
  if (raw === undefined || raw === null) return { type: 'open', min: null, max: null }
  if (typeof raw !== 'object') throw new PlanValidationError(`${where}: objetivo no válido`)
  const t = raw as Record<string, unknown>
  const type = parseEnum(t.type, TARGET_TYPES, `${where}: tipo de objetivo`)
  if (type === 'open') return { type, min: null, max: null }

  const [lo, hi, label] = TARGET_RANGES[type]
  const msg = `${where}: el objetivo debe ser ${label}`
  const isZone = type === 'hr_zone' || type === 'power_zone' || type === 'rpe'

  let min = t.min == null ? null : parseNumber(t.min, lo, hi, msg)
  let max = t.max == null ? null : parseNumber(t.max, lo, hi, msg)
  if (min === null && max === null) throw new PlanValidationError(`${where}: falta el valor del objetivo`)
  if (min === null) min = max
  if (max === null) max = min
  if (min! > max!) throw new PlanValidationError(`${where}: el mínimo del objetivo es mayor que el máximo`)
  if (isZone) {
    min = Math.round(min!)
    max = Math.round(max!)
  }
  return { type, min, max }
}
