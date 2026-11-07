import { randomUUID } from 'crypto'
import { addDays, dayKey } from '../training/calendar'

// ─── Tipos ───────────────────────────────────────────────────────────────────

// A: objetivo principal de la temporada (se planifica todo hacia ella)
// B: importante (mini-taper y recuperación) · C: se corre como entreno
export type RacePriority = 'A' | 'B' | 'C'

export type RaceType =
  | 'road_race' | 'gran_fondo' | 'criterium' | 'time_trial' | 'hill_climb' | 'stage_race'
  | 'gravel' | 'mtb' | 'cyclocross' | 'other'

export const RACE_PRIORITIES: RacePriority[] = ['A', 'B', 'C']
export const RACE_TYPES: RaceType[] = [
  'road_race', 'gran_fondo', 'criterium', 'time_trial', 'hill_climb', 'stage_race',
  'gravel', 'mtb', 'cyclocross', 'other',
]

// Campos que se pueden dar al crear o editar una carrera
export interface RaceEventInput {
  name?: unknown
  date?: unknown          // 'YYYY-MM-DD' (primer día si dura varios)
  days?: unknown          // días de competición (vueltas por etapas); default 1
  priority?: unknown
  type?: unknown
  distanceKm?: unknown
  elevationM?: unknown
  location?: unknown
  goal?: unknown          // objetivo en la carrera (terminar, bajar de 8 h, top 10...)
  notes?: unknown
  result?: unknown        // resultado, una vez corrida
}

export interface RaceEventProps {
  id: string
  userId: string
  name: string
  date: string
  days: number
  priority: RacePriority
  type: RaceType
  distanceKm: number | null
  elevationM: number | null
  location: string | null
  goal: string | null
  notes: string | null
  result: string | null
  createdAt: string
  updatedAt: string
}

export class RaceValidationError extends Error {}
export class RaceEventNotFoundError extends Error {
  constructor() { super('Carrera no encontrada') }
}

// ─── Límites ─────────────────────────────────────────────────────────────────

const NAME_MAX = 120
const SHORT_TEXT_MAX = 300
const TEXT_MAX = 1000
const MAX_DAYS = 21
const PAST_DAYS = 366
const FUTURE_DAYS = 731

// ─── Entidad ─────────────────────────────────────────────────────────────────

export class RaceEvent implements RaceEventProps {
  readonly id: string
  readonly userId: string
  name: string
  date: string
  days: number
  priority: RacePriority
  type: RaceType
  distanceKm: number | null
  elevationM: number | null
  location: string | null
  goal: string | null
  notes: string | null
  result: string | null
  readonly createdAt: string
  updatedAt: string

  constructor(props: RaceEventProps) {
    this.id = props.id
    this.userId = props.userId
    this.name = props.name
    this.date = props.date
    this.days = props.days
    this.priority = props.priority
    this.type = props.type
    this.distanceKm = props.distanceKm
    this.elevationM = props.elevationM
    this.location = props.location
    this.goal = props.goal
    this.notes = props.notes
    this.result = props.result
    this.createdAt = props.createdAt
    this.updatedAt = props.updatedAt
  }

  // Throws RaceValidationError
  static create(userId: string, input: RaceEventInput): RaceEvent {
    if (input.name === undefined) throw new RaceValidationError('Falta el nombre de la carrera')
    if (input.date === undefined) throw new RaceValidationError('Falta la fecha de la carrera')
    if (input.priority === undefined) throw new RaceValidationError('Falta la prioridad de la carrera (A, B o C)')
    const now = new Date().toISOString()
    const race = new RaceEvent({
      id: randomUUID(),
      userId,
      name: '',
      date: '',
      days: 1,
      priority: 'C',
      type: 'other',
      distanceKm: null,
      elevationM: null,
      location: null,
      goal: null,
      notes: null,
      result: null,
      createdAt: now,
      updatedAt: now,
    })
    race.update(input)
    return race
  }

  // Partial update; undefined = keep, null or '' = clear (optional fields). Throws RaceValidationError.
  update(input: RaceEventInput): void {
    const next = {
      name: input.name !== undefined ? parseName(input.name) : this.name,
      date: input.date !== undefined ? parseDate(input.date, this.date) : this.date,
      days: input.days !== undefined
        ? (input.days === null ? 1 : Math.round(parseNumber(input.days, 1, MAX_DAYS, `Los días de competición deben estar entre 1 y ${MAX_DAYS}`)))
        : this.days,
      priority: input.priority !== undefined ? parsePriority(input.priority) : this.priority,
      type: input.type !== undefined ? parseType(input.type) : this.type,
      distanceKm: input.distanceKm !== undefined
        ? parseOptionalNumber(input.distanceKm, 1, 5000, 'La distancia debe estar entre 1 y 5000 km')
        : this.distanceKm,
      elevationM: input.elevationM !== undefined
        ? parseOptionalNumber(input.elevationM, 0, 50000, 'El desnivel debe estar entre 0 y 50000 m')
        : this.elevationM,
      location: input.location !== undefined ? parseText(input.location, 'El lugar', NAME_MAX) : this.location,
      goal: input.goal !== undefined ? parseText(input.goal, 'El objetivo', SHORT_TEXT_MAX) : this.goal,
      notes: input.notes !== undefined ? parseText(input.notes, 'Las notas', TEXT_MAX) : this.notes,
      result: input.result !== undefined ? parseText(input.result, 'El resultado', SHORT_TEXT_MAX) : this.result,
    }
    if (next.distanceKm !== null) next.distanceKm = Math.round(next.distanceKm * 10) / 10
    if (next.elevationM !== null) next.elevationM = Math.round(next.elevationM)

    Object.assign(this, next)
    this.updatedAt = new Date().toISOString()
  }

  // Último día de competición ('YYYY-MM-DD')
  get endDate(): string {
    return addDays(this.date, this.days - 1)
  }
}

// ─── Validación ──────────────────────────────────────────────────────────────

function parseName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new RaceValidationError('El nombre de la carrera no puede estar vacío')
  const t = value.trim()
  if (t.length > NAME_MAX) throw new RaceValidationError(`El nombre es demasiado largo (máx. ${NAME_MAX} caracteres)`)
  return t
}

function parseDate(value: unknown, current: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RaceValidationError('La fecha debe tener el formato AAAA-MM-DD')
  }
  const d = new Date(`${value}T12:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new RaceValidationError(`Fecha no válida: ${value}`)
  }
  if (value !== current) {
    const today = dayKey(new Date())
    if (value < addDays(today, -PAST_DAYS) || value > addDays(today, FUTURE_DAYS)) {
      throw new RaceValidationError('La fecha debe estar entre hace un año y dentro de dos años')
    }
  }
  return value
}

function parsePriority(value: unknown): RacePriority {
  const v = typeof value === 'string' ? value.trim().toUpperCase() : value
  if (typeof v !== 'string' || !RACE_PRIORITIES.includes(v as RacePriority)) {
    throw new RaceValidationError(`Prioridad no válida: ${String(value)} (A, B o C)`)
  }
  return v as RacePriority
}

function parseType(value: unknown): RaceType {
  if (value === null) return 'other'
  if (typeof value !== 'string' || !RACE_TYPES.includes(value as RaceType)) {
    throw new RaceValidationError(`Tipo de prueba no válido: ${String(value)} (valores: ${RACE_TYPES.join(', ')})`)
  }
  return value as RaceType
}

function parseText(value: unknown, label: string, max: number): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new RaceValidationError(`${label} debe ser texto`)
  const t = value.trim()
  if (t.length > max) throw new RaceValidationError(`${label} es demasiado largo (máx. ${max} caracteres)`)
  return t || null
}

function parseNumber(value: unknown, min: number, max: number, msg: string): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw new RaceValidationError(msg)
  return n
}

function parseOptionalNumber(value: unknown, min: number, max: number, msg: string): number | null {
  if (value === null || value === '') return null
  return parseNumber(value, min, max, msg)
}
