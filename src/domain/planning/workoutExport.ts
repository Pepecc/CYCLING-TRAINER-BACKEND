import { HR_ZONES } from '../training/trainingMetrics'
import type { PlannedWorkout, StepKind, StepTarget } from './PlannedWorkout'

// Exportar un entreno planificado a un fichero de entreno estructurado (.fit para el ELEMNT / Garmin, .zwo para Zwift y otras apps).

export type ExportFormat = 'fit' | 'zwo'
export const EXPORT_FORMATS: ExportFormat[] = ['fit', 'zwo']

export interface ExportProfile {
  ftp: number | null
  maxHr: number | null
  restingHr: number | null
}

export interface ExportedFile {
  filename: string
  contentType: string
  data: Buffer
  warnings: string[]
}

// Puerto: cada formato lo implementa un codificador de infraestructura
export interface WorkoutFileEncoder {
  readonly format: ExportFormat
  encode(workout: PlannedWorkout, profile: ExportProfile | null): ExportedFile
}

export class ExportError extends Error {}

// Límites de las zonas de Coggan en % del FTP (Z7 sin techo: se exporta hasta el 200 %)
export const POWER_ZONE_PCT: Array<[number, number]> = [
  [0, 55], [56, 75], [76, 90], [91, 105], [106, 120], [121, 150], [151, 200],
]

// Equivalencia orientativa de cada zona de FC con el % del FTP (para formatos que solo admiten potencia)
export const HR_ZONE_FTP_FRACTION = [0.55, 0.68, 0.83, 0.97, 1.08]

// Objetivo resuelto a una unidad que entienden los dispositivos
export type ResolvedTarget =
  | { kind: 'open' }
  | { kind: 'ftp_percent'; low: number; high: number }      // el dispositivo aplica su FTP
  | { kind: 'watts'; low: number; high: number }
  | { kind: 'bpm'; low: number; high: number }
  | { kind: 'hr_zone'; zone: number }                        // zonas de FC del dispositivo (sin FC en el perfil)

export function resolveTarget(t: StepTarget, profile: ExportProfile | null): ResolvedTarget {
  const lo = t.min ?? 0
  const hi = t.max ?? lo
  switch (t.type) {
    case 'power_zone':
      return { kind: 'ftp_percent', low: POWER_ZONE_PCT[lo - 1][0], high: POWER_ZONE_PCT[hi - 1][1] }
    case 'ftp_percent':
      return { kind: 'ftp_percent', low: Math.round(lo), high: Math.round(hi) }
    case 'power_w':
      return { kind: 'watts', low: Math.round(lo), high: Math.round(hi) }
    case 'hr_bpm':
      return { kind: 'bpm', low: Math.round(lo), high: Math.round(hi) }
    case 'hr_zone': {
      const zones = hrZonesBpm(profile)
      if (zones) return { kind: 'bpm', low: zones[lo - 1][0], high: zones[hi - 1][1] }
      // Without max / resting HR, the device's own zones (a range goes to its central zone; the note keeps the range)
      return { kind: 'hr_zone', zone: Math.round((lo + hi) / 2) }
    }
    case 'rpe':
    case 'open':
    default:
      return { kind: 'open' }
  }
}

// Karvonen bpm bounds of the 5 HR zones (same as the profile), or null without max / resting HR
export function hrZonesBpm(p: ExportProfile | null): Array<[number, number]> | null {
  if (!p?.maxHr || !p.restingHr || p.restingHr >= p.maxHr) return null
  const reserve = p.maxHr - p.restingHr
  const bpm = (f: number) => Math.round(p.restingHr! + f * reserve)
  return HR_ZONES.map((z, i) => [i === 0 ? bpm(z.min) : bpm(z.min) + 1, bpm(z.max)])
}

export const STEP_LABELS: Record<StepKind, string> = {
  warmup: 'Calentamiento',
  work: 'Trabajo',
  recovery: 'Recuperación',
  steady: 'Continuo',
  cooldown: 'Vuelta a la calma',
}

// Human description of a target, for step notes on the device
export function targetText(t: StepTarget): string | null {
  const range = (a: number | null, b: number | null, unit = '') => (a === b ? `${a}${unit}` : `${a}-${b}${unit}`)
  const zones = (a: number | null, b: number | null) => (a === b ? `Z${a}` : `Z${a}-Z${b}`)
  switch (t.type) {
    case 'hr_zone': return `FC ${zones(t.min, t.max)}`
    case 'power_zone': return `Potencia ${zones(t.min, t.max)}`
    case 'ftp_percent': return `${range(t.min, t.max)} % FTP`
    case 'power_w': return range(t.min, t.max, ' W')
    case 'hr_bpm': return range(t.min, t.max, ' ppm')
    case 'rpe': return `RPE ${range(t.min, t.max)}`
    default: return null
  }
}

// Safe file name from the date and title (ASCII, no spaces)
export function exportFileName(w: PlannedWorkout, ext: string): string {
  const slug = w.title
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 40) || 'entreno'
  return `${w.date}_${slug}.${ext}`
}
