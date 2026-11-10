import { addDays, dayKey } from '../training/calendar'

// Check-in diario: cómo se encuentra el ciclista cada mañana (uno por día, en su zona horaria).
// Escalas de 1 a 5 en las que el número alto es siempre "más": más cansancio, mejor sueño, mejores sensaciones, más dolor.

export interface DailyCheckInFields {
  fatigue: number | null        // 1 fresco · 3 normal · 5 agotado
  sleepHours: number | null     // horas dormidas
  sleepQuality: number | null   // 1 muy mala · 5 muy buena
  feeling: number | null        // sensaciones / ánimo: 1 muy malas · 5 muy buenas
  soreness: number | null       // dolor muscular: 1 nada · 5 mucho
  morningHr: number | null      // FC al despertar (ppm)
  notes: string | null
}

export interface DailyCheckInProps extends DailyCheckInFields {
  userId: string
  date: string                  // 'YYYY-MM-DD'
  createdAt: string
  updatedAt: string
}

export type CheckInInput = { [K in keyof DailyCheckInFields]?: unknown }

export class CheckInValidationError extends Error {}
export class CheckInNotFoundError extends Error {
  constructor() { super('No hay check-in ese día') }
}

const SCALE_FIELDS = ['fatigue', 'sleepQuality', 'feeling', 'soreness'] as const
const SCALE_LABELS: Record<typeof SCALE_FIELDS[number], string> = {
  fatigue: 'El cansancio',
  sleepQuality: 'La calidad del sueño',
  feeling: 'Las sensaciones',
  soreness: 'El dolor muscular',
}
const NOTES_MAX = 500
export const CHECKIN_PAST_DAYS = 60
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/

export class DailyCheckIn implements DailyCheckInProps {
  readonly userId: string
  readonly date: string
  fatigue: number | null
  sleepHours: number | null
  sleepQuality: number | null
  feeling: number | null
  soreness: number | null
  morningHr: number | null
  notes: string | null
  readonly createdAt: string
  updatedAt: string

  constructor(p: DailyCheckInProps) {
    this.userId = p.userId
    this.date = p.date
    this.fatigue = p.fatigue ?? null
    this.sleepHours = p.sleepHours ?? null
    this.sleepQuality = p.sleepQuality ?? null
    this.feeling = p.feeling ?? null
    this.soreness = p.soreness ?? null
    this.morningHr = p.morningHr ?? null
    this.notes = p.notes ?? null
    this.createdAt = p.createdAt
    this.updatedAt = p.updatedAt
  }

  // Throws CheckInValidationError
  static create(userId: string, date: string, input: CheckInInput): DailyCheckIn {
    const now = new Date().toISOString()
    const c = new DailyCheckIn({
      userId, date: parseCheckInDate(date), createdAt: now, updatedAt: now,
      fatigue: null, sleepHours: null, sleepQuality: null, feeling: null, soreness: null, morningHr: null, notes: null,
    })
    c.update(input)
    return c
  }

  // Partial update: undefined = keep, null = clear. At least one value must remain. Throws CheckInValidationError.
  update(input: CheckInInput): void {
    const next: DailyCheckInFields = { ...this.fields() }
    for (const key of SCALE_FIELDS) {
      if (input[key] !== undefined) next[key] = parseScale(input[key], SCALE_LABELS[key])
    }
    if (input.sleepHours !== undefined) {
      const h = parseOptional(input.sleepHours, 0, 16, 'Las horas de sueño deben estar entre 0 y 16')
      next.sleepHours = h === null ? null : Math.round(h * 4) / 4   // cuartos de hora
    }
    if (input.morningHr !== undefined) {
      const hr = parseOptional(input.morningHr, 25, 140, 'La FC al despertar debe estar entre 25 y 140 ppm')
      next.morningHr = hr === null ? null : Math.round(hr)
    }
    if (input.notes !== undefined) next.notes = parseNotes(input.notes)

    const { notes, ...values } = next
    if (Object.values(values).every(v => v === null) && !notes) {
      throw new CheckInValidationError('El check-in está vacío: indica al menos un dato (cansancio, sueño, sensaciones...)')
    }
    Object.assign(this, next)
    this.updatedAt = new Date().toISOString()
  }

  fields(): DailyCheckInFields {
    return {
      fatigue: this.fatigue,
      sleepHours: this.sleepHours,
      sleepQuality: this.sleepQuality,
      feeling: this.feeling,
      soreness: this.soreness,
      morningHr: this.morningHr,
      notes: this.notes,
    }
  }
}

// ─── Disponibilidad para entrenar (readiness) ────────────────────────────────
// Reglas sencillas y explicables; no sustituyen al criterio del coach ni a un médico.

export type ReadinessLevel = 'good' | 'normal' | 'caution' | 'rest'

export interface Readiness {
  level: ReadinessLevel
  reasons: string[]
  morningHrDelta: number | null   // ppm sobre la referencia (media de los días anteriores o FC en reposo del perfil)
}

const MIN_BASELINE_DAYS = 3

// recent: check-ins de los días anteriores (para la referencia de FC y la tendencia), en cualquier orden
export function assessReadiness(
  c: DailyCheckIn, recent: DailyCheckIn[], profileRestingHr: number | null
): Readiness {
  const strong: string[] = []
  const mild: string[] = []

  if (c.fatigue === 5) strong.push('cansancio muy alto (5/5)')
  else if (c.fatigue === 4) mild.push('cansancio alto (4/5)')

  if (c.feeling === 1) strong.push('sensaciones muy malas (1/5)')
  else if (c.feeling === 2) mild.push('sensaciones malas (2/5)')

  if (c.soreness === 5) strong.push('dolor muscular fuerte (5/5)')
  else if (c.soreness === 4) mild.push('bastante dolor muscular (4/5)')

  if (c.sleepHours !== null && c.sleepHours < 5) strong.push(`ha dormido muy poco (${fmtHours(c.sleepHours)})`)
  else if (c.sleepHours !== null && c.sleepHours < 6.5) mild.push(`ha dormido poco (${fmtHours(c.sleepHours)})`)
  if (c.sleepQuality !== null && c.sleepQuality <= 2) mild.push(`sueño de mala calidad (${c.sleepQuality}/5)`)

  // Morning HR against the cyclist's own baseline (the previous mornings, or the resting HR of the profile)
  const before = recent.filter(r => r.date < c.date && r.date >= addDays(c.date, -14) && r.morningHr !== null)
  const baseline = before.length >= MIN_BASELINE_DAYS
    ? before.reduce((s, r) => s + r.morningHr!, 0) / before.length
    : profileRestingHr
  let morningHrDelta: number | null = null
  if (c.morningHr !== null && baseline) {
    morningHrDelta = Math.round(c.morningHr - baseline)
    if (morningHrDelta >= 10) strong.push(`FC al despertar ${morningHrDelta} ppm por encima de lo normal`)
    else if (morningHrDelta >= 6) mild.push(`FC al despertar ${morningHrDelta} ppm por encima de lo normal`)
  }

  // Tiredness that drags on: the two previous days also at 4-5
  const prev = [1, 2].map(n => recent.find(r => r.date === addDays(c.date, -n)))
  if (c.fatigue !== null && c.fatigue >= 4 && prev.every(p => p?.fatigue != null && p.fatigue >= 4)) {
    strong.push('tres días seguidos con cansancio alto')
  }

  let level: ReadinessLevel
  if (strong.length >= 2 || (strong.length === 1 && mild.length >= 2)) level = 'rest'
  else if (strong.length === 1 || mild.length >= 2) level = 'caution'
  else if (mild.length === 1) level = 'normal'
  else {
    const fresh = (c.fatigue === null || c.fatigue <= 2) && (c.feeling === null || c.feeling >= 4)
      && (c.sleepHours === null || c.sleepHours >= 7) && (c.fatigue !== null || c.feeling !== null)
    level = fresh ? 'good' : 'normal'
  }
  return { level, reasons: [...strong, ...mild], morningHrDelta }
}

export const READINESS_GUIDE: Record<ReadinessLevel, string> = {
  good: 'Buen día para la sesión de calidad prevista.',
  normal: 'Sin señales de alarma: entrenar según el plan.',
  caution: 'Señales de fatiga: mantener el entreno pero con menos volumen o intensidad (o cambiar la sesión de calidad por resistencia suave).',
  rest: 'Varias señales de fatiga: hoy mejor descanso o rodaje muy suave. Si se repite, plantear descarga.',
}

// ─── Validación ──────────────────────────────────────────────────────────────

export function parseCheckInDate(value: unknown): string {
  if (typeof value !== 'string' || !DATE_KEY.test(value) || Number.isNaN(Date.parse(`${value}T12:00:00Z`))
    || new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new CheckInValidationError('La fecha debe tener el formato AAAA-MM-DD')
  }
  const today = dayKey(new Date())
  if (value > today) throw new CheckInValidationError('No se puede hacer el check-in de un día futuro')
  if (value < addDays(today, -CHECKIN_PAST_DAYS)) {
    throw new CheckInValidationError(`Solo se pueden registrar check-ins de los últimos ${CHECKIN_PAST_DAYS} días`)
  }
  return value
}

function toNumber(value: unknown): unknown {
  return typeof value === 'string' && value.trim() !== '' ? Number(value.replace(',', '.')) : value
}

function parseOptional(value: unknown, min: number, max: number, msg: string): number | null {
  if (value === null || value === '') return null
  const n = toNumber(value)
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw new CheckInValidationError(msg)
  return n
}

function parseScale(value: unknown, label: string): number | null {
  const n = parseOptional(value, 1, 5, `${label} debe ser un valor de 1 a 5`)
  return n === null ? null : Math.round(n)
}

function parseNotes(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new CheckInValidationError('Las notas deben ser texto')
  const t = value.trim()
  if (t.length > NOTES_MAX) throw new CheckInValidationError(`Las notas son demasiado largas (máx. ${NOTES_MAX} caracteres)`)
  return t || null
}

const fmtHours = (h: number) => `${Math.floor(h)} h${h % 1 ? ` ${Math.round((h % 1) * 60)} min` : ''}`
