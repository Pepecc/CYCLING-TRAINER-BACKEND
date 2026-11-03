import { HR_ZONES } from '../training/trainingMetrics'

export type Experience = 'beginner' | 'intermediate' | 'advanced'

export const EXPERIENCES: Experience[] = ['beginner', 'intermediate', 'advanced']

export interface PowerZone {
  name: string
  min: number
  max: number | null
}

export interface HeartRateZone {
  zone: string
  name: string
  min: number   // ppm
  max: number   // ppm
}

export interface PowerZones {
  z1: PowerZone
  z2: PowerZone
  z3: PowerZone
  z4: PowerZone
  z5: PowerZone
  z6: PowerZone
  z7: PowerZone
}

// Campos editables del perfil (por el usuario en el formulario o por el coach con la tool update_profile)
export interface CyclistProfileFields {
  ftp: number | null
  weightKg: number | null
  hoursPerWeek: number | null
  goal: string | null
  experience: Experience
  maxHr: number | null            // FC máxima (ppm)
  restingHr: number | null        // FC en reposo (ppm)
  availableDays: string | null    // p.ej. "martes, jueves, sábado y domingo"
  targetEvents: string | null     // eventos y fechas objetivo de la temporada
  limitations: string | null      // lesiones, molestias, limitaciones físicas
}

export interface CyclistProfileProps extends CyclistProfileFields {
  userId: string
  updatedAt: string
}

export class ProfileValidationError extends Error {}

const TEXT_MAX = 500

// Rangos razonables para un ciclista amateur; null siempre está permitido (borra el dato)
const NUMERIC_RANGES: Record<'ftp' | 'weightKg' | 'hoursPerWeek' | 'maxHr' | 'restingHr', [number, number, string]> = {
  ftp:          [50, 600, 'El FTP debe estar entre 50 y 600 W'],
  weightKg:     [30, 200, 'El peso debe estar entre 30 y 200 kg'],
  hoursPerWeek: [0.5, 40, 'Las horas semanales deben estar entre 0,5 y 40'],
  maxHr:        [100, 230, 'La FC máxima debe estar entre 100 y 230 ppm'],
  restingHr:    [25, 120, 'La FC en reposo debe estar entre 25 y 120 ppm'],
}

export class CyclistProfile implements CyclistProfileProps {
  readonly userId: string
  ftp: number | null
  weightKg: number | null
  hoursPerWeek: number | null
  goal: string | null
  experience: Experience
  maxHr: number | null
  restingHr: number | null
  availableDays: string | null
  targetEvents: string | null
  limitations: string | null
  updatedAt: string

  constructor(props: CyclistProfileProps) {
    this.userId = props.userId
    this.ftp = props.ftp
    this.weightKg = props.weightKg
    this.hoursPerWeek = props.hoursPerWeek
    this.goal = props.goal
    this.experience = props.experience
    this.maxHr = props.maxHr
    this.restingHr = props.restingHr
    this.availableDays = props.availableDays
    this.targetEvents = props.targetEvents
    this.limitations = props.limitations
    this.updatedAt = props.updatedAt
  }

  static create(userId: string): CyclistProfile {
    return new CyclistProfile({
      userId,
      ftp: null,
      weightKg: null,
      hoursPerWeek: null,
      goal: null,
      experience: 'intermediate',
      maxHr: null,
      restingHr: null,
      availableDays: null,
      targetEvents: null,
      limitations: null,
      updatedAt: new Date().toISOString(),
    })
  }

  // Applies a partial update; undefined = keep, null = clear. Throws ProfileValidationError.
  update(patch: Partial<CyclistProfileFields>): void {
    const next: CyclistProfileFields = { ...this.fields(), ...stripUndefined(patch) }

    for (const [key, [min, max, msg]] of Object.entries(NUMERIC_RANGES)) {
      const v = next[key as keyof typeof NUMERIC_RANGES]
      if (v === null) continue
      if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
        throw new ProfileValidationError(msg)
      }
    }

    if (!EXPERIENCES.includes(next.experience)) {
      throw new ProfileValidationError('Nivel no válido (beginner, intermediate o advanced)')
    }

    if (next.maxHr !== null && next.restingHr !== null && next.restingHr >= next.maxHr) {
      throw new ProfileValidationError('La FC en reposo debe ser menor que la FC máxima')
    }

    for (const key of ['goal', 'availableDays', 'targetEvents', 'limitations'] as const) {
      const v = next[key]
      if (v === null) continue
      if (typeof v !== 'string') throw new ProfileValidationError(`Valor no válido en ${key}`)
      const trimmed = v.trim()
      if (trimmed.length > TEXT_MAX) throw new ProfileValidationError(`Texto demasiado largo (máx. ${TEXT_MAX} caracteres)`)
      next[key] = trimmed || null
    }

    if (next.ftp !== null) next.ftp = Math.round(next.ftp)
    if (next.maxHr !== null) next.maxHr = Math.round(next.maxHr)
    if (next.restingHr !== null) next.restingHr = Math.round(next.restingHr)

    Object.assign(this, next)
    this.updatedAt = new Date().toISOString()
  }

  fields(): CyclistProfileFields {
    return {
      ftp: this.ftp,
      weightKg: this.weightKg,
      hoursPerWeek: this.hoursPerWeek,
      goal: this.goal,
      experience: this.experience,
      maxHr: this.maxHr,
      restingHr: this.restingHr,
      availableDays: this.availableDays,
      targetEvents: this.targetEvents,
      limitations: this.limitations,
    }
  }

  get wattsPerKg(): number | null {
    if (!this.ftp || !this.weightKg) return null
    return Math.round((this.ftp / this.weightKg) * 100) / 100
  }

  // Coggan 7-zone model
  get powerZones(): PowerZones | null {
    if (!this.ftp) return null
    const f = this.ftp
    return {
      z1: { name: 'Recuperación activa',    min: 0,                      max: Math.round(f * 0.55) },
      z2: { name: 'Resistencia',            min: Math.round(f * 0.56),   max: Math.round(f * 0.75) },
      z3: { name: 'Tempo',                  min: Math.round(f * 0.76),   max: Math.round(f * 0.90) },
      z4: { name: 'Umbral láctico',         min: Math.round(f * 0.91),   max: Math.round(f * 1.05) },
      z5: { name: 'VO2max',                 min: Math.round(f * 1.06),   max: Math.round(f * 1.20) },
      z6: { name: 'Capacidad anaeróbica',   min: Math.round(f * 1.21),   max: Math.round(f * 1.50) },
      z7: { name: 'Potencia neuromuscular', min: Math.round(f * 1.51),   max: null },
    }
  }

  // Karvonen 5-zone model on heart rate reserve (needs max and resting HR)
  get heartRateZones(): HeartRateZone[] | null {
    if (!this.maxHr || !this.restingHr || this.restingHr >= this.maxHr) return null
    const rest = this.restingHr
    const reserve = this.maxHr - rest
    const bpm = (fraction: number) => Math.round(rest + fraction * reserve)
    return HR_ZONES.map((z, i) => ({
      zone: z.zone,
      name: z.name,
      min: i === 0 ? bpm(z.min) : bpm(z.min) + 1,
      max: bpm(z.max),
    }))
  }

  isComplete(): boolean {
    return !!(this.ftp && this.weightKg && this.hoursPerWeek && this.goal)
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
}
