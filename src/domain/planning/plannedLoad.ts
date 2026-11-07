import { HR_ZONES, LoadProfile, heartRateReserve, hrTssPerHour } from '../training/trainingMetrics'
import type { StepTarget, WorkoutBlock } from './PlannedWorkout'

// Estimación de la carga (TSS) de un entreno planificado a partir de su estructura.
// Objetivos de potencia → TSS clásico (horas × IF² × 100).
// Objetivos de FC → hrTSS, la misma escala con la que se mide la carga real de los entrenos sin potencia.

// IF aproximado en el centro de cada zona de Coggan (Z1–Z7)
const POWER_ZONE_IF = [0.50, 0.65, 0.83, 0.98, 1.13, 1.35, 1.60]

// IF cuando no se puede calcular la intensidad (objetivo libre, o faltan FTP / FC en el perfil)
const FALLBACK_IF = 0.6

type Intensity = { kind: 'power'; if: number } | { kind: 'hr'; hrr: number }

const mid = (t: StepTarget): number => ((t.min ?? 0) + (t.max ?? t.min ?? 0)) / 2

function zoneAverage(values: number[], min: number, max: number): number {
  const picked = values.slice(min - 1, max)
  return picked.reduce((a, b) => a + b, 0) / picked.length
}

export function stepIntensity(target: StepTarget, profile: LoadProfile | null): Intensity {
  switch (target.type) {
    case 'power_zone':
      return { kind: 'power', if: zoneAverage(POWER_ZONE_IF, target.min!, target.max!) }
    case 'ftp_percent':
      return { kind: 'power', if: mid(target) / 100 }
    case 'power_w':
      return profile?.ftp ? { kind: 'power', if: mid(target) / profile.ftp } : { kind: 'power', if: FALLBACK_IF }
    case 'hr_zone': {
      const centers = HR_ZONES.map(z => (z.min + z.max) / 2)
      return { kind: 'hr', hrr: zoneAverage(centers, target.min!, target.max!) }
    }
    case 'hr_bpm': {
      const hrr = heartRateReserve(mid(target), profile?.maxHr ?? null, profile?.restingHr ?? null)
      return hrr !== null ? { kind: 'hr', hrr } : { kind: 'power', if: FALLBACK_IF }
    }
    case 'rpe':
      // RPE 5 ≈ Z2 alta, RPE 8 ≈ umbral, RPE 10 ≈ por encima del umbral
      return { kind: 'power', if: 0.4 + 0.065 * mid(target) }
    case 'open':
    default:
      return { kind: 'power', if: FALLBACK_IF }
  }
}

function tssPerHour(intensity: Intensity): number {
  return intensity.kind === 'power' ? intensity.if * intensity.if * 100 : hrTssPerHour(intensity.hrr)
}

export function blocksDurationSeconds(blocks: WorkoutBlock[]): number {
  return blocks.reduce(
    (acc, b) => acc + b.repeat * b.steps.reduce((s, step) => s + step.durationSeconds, 0),
    0
  )
}

export function estimateBlocksTss(blocks: WorkoutBlock[], profile: LoadProfile | null): number {
  let tss = 0
  for (const b of blocks) {
    for (const step of b.steps) {
      tss += b.repeat * (step.durationSeconds / 3600) * tssPerHour(stepIntensity(step.target, profile))
    }
  }
  return Math.round(tss)
}
