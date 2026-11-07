import { HR_ZONES, LoadProfile } from '../training/trainingMetrics'
import type { StepTarget, WorkoutBlock, WorkoutStep } from './PlannedWorkout'

// Texto compacto de la estructura, p. ej.:
//   15' Z1-Z2 FC (118-145 ppm) · 4 × (8' Z4 FC (159-172 ppm) + 4' Z1 FC (118-131 ppm)) · 10' Z1 FC (118-131 ppm)

// Límites de las zonas de Coggan como fracción del FTP (Z7 sin techo)
const POWER_ZONE_BOUNDS: Array<[number, number | null]> = [
  [0, 0.55], [0.56, 0.75], [0.76, 0.90], [0.91, 1.05], [1.06, 1.20], [1.21, 1.50], [1.51, null],
]

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}"`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  if (m >= 60 && s === 0) {
    const h = Math.floor(m / 60)
    const rest = m % 60
    return rest ? `${h}h${String(rest).padStart(2, '0')}'` : `${h}h`
  }
  return s ? `${m}'${String(s).padStart(2, '0')}"` : `${m}'`
}

const range = (t: StepTarget): string => (t.min === t.max ? `${t.min}` : `${t.min}-${t.max}`)

export function formatTarget(t: StepTarget, profile: LoadProfile | null): string {
  switch (t.type) {
    case 'hr_zone': {
      const label = t.min === t.max ? `Z${t.min} FC` : `Z${t.min}-Z${t.max} FC`
      const { maxHr, restingHr } = profile ?? {}
      if (!maxHr || !restingHr || restingHr >= maxHr) return label
      const bpm = (f: number) => Math.round(restingHr + f * (maxHr - restingHr))
      const lo = HR_ZONES[t.min! - 1].min
      const hi = HR_ZONES[t.max! - 1].max
      return `${label} (${bpm(lo) + (t.min === 1 ? 0 : 1)}-${bpm(hi)} ppm)`
    }
    case 'power_zone': {
      const label = t.min === t.max ? `Z${t.min} potencia` : `Z${t.min}-Z${t.max} potencia`
      if (!profile?.ftp) return label
      const lo = Math.round(POWER_ZONE_BOUNDS[t.min! - 1][0] * profile.ftp)
      const top = POWER_ZONE_BOUNDS[t.max! - 1][1]
      return `${label} (${top === null ? `${lo}+` : `${lo}-${Math.round(top * profile.ftp)}`} W)`
    }
    case 'ftp_percent': {
      const label = `${range(t)} % FTP`
      if (!profile?.ftp) return label
      const w = (p: number) => Math.round((p / 100) * profile.ftp!)
      return `${label} (${t.min === t.max ? w(t.min!) : `${w(t.min!)}-${w(t.max!)}`} W)`
    }
    case 'power_w':
      return `${range(t)} W`
    case 'hr_bpm':
      return `${range(t)} ppm`
    case 'rpe':
      return `RPE ${range(t)}`
    case 'open':
    default:
      return 'libre'
  }
}

function formatStep(step: WorkoutStep, profile: LoadProfile | null): string {
  let text = `${formatDuration(step.durationSeconds)} ${formatTarget(step.target, profile)}`
  if (step.cadenceMin !== null) {
    text += step.cadenceMin === step.cadenceMax || step.cadenceMax === null
      ? ` a ${step.cadenceMin} rpm`
      : ` a ${step.cadenceMin}-${step.cadenceMax} rpm`
  }
  return text
}

export function formatStructure(blocks: WorkoutBlock[], profile: LoadProfile | null): string {
  return blocks
    .map(b => {
      const steps = b.steps.map(s => formatStep(s, profile))
      if (b.repeat === 1) return steps.join(' + ')
      return `${b.repeat} × (${steps.join(' + ')})`
    })
    .join(' · ')
}
