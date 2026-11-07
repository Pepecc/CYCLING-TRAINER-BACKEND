import { WahooWorkout } from '../wahoo/WahooWorkout'

// Métricas de entrenamiento compartidas por el análisis de entrenos y las tools del agente

export function classifyPower(power: number, ftp: number): string {
  const ratio = power / ftp
  if (ratio < 0.55) return 'Z1 — Recuperación activa'
  if (ratio < 0.75) return 'Z2 — Resistencia'
  if (ratio < 0.90) return 'Z3 — Tempo'
  if (ratio < 1.05) return 'Z4 — Umbral láctico'
  if (ratio < 1.20) return 'Z5 — VO2max'
  if (ratio < 1.50) return 'Z6 — Capacidad anaeróbica'
  return 'Z7 — Potencia neuromuscular'
}

// IF = NP / FTP
export function intensityFactor(np: number | null, ftp: number | null | undefined): number | null {
  if (!np || !ftp) return null
  return Math.round((np / ftp) * 100) / 100
}

// TSS = (segundos × NP × IF) / (FTP × 3600) × 100
export function estimateTss(seconds: number | null, np: number | null, ftp: number | null | undefined): number | null {
  const iF = intensityFactor(np, ftp)
  if (!seconds || !np || !ftp || !iF) return null
  return Math.round(((seconds * np * iF) / (ftp * 3600)) * 100)
}

// ─── Frecuencia cardiaca ─────────────────────────────────────────────────────
// Zonas de Karvonen sobre la FC de reserva (FCR = FC máx − FC reposo).
// El umbral se toma en el 85 % de la FCR (≈ 89 % de la FC máx para un amateur típico).

export const HR_THRESHOLD_HRR = 0.85

// Límites superiores de cada zona como fracción de la FCR; Z1 empieza en el 50 %
export const HR_ZONES: Array<{ zone: string; name: string; min: number; max: number }> = [
  { zone: 'Z1', name: 'Recuperación', min: 0.50, max: 0.60 },
  { zone: 'Z2', name: 'Resistencia',  min: 0.60, max: 0.70 },
  { zone: 'Z3', name: 'Tempo',        min: 0.70, max: 0.80 },
  { zone: 'Z4', name: 'Umbral',       min: 0.80, max: 0.90 },
  { zone: 'Z5', name: 'VO2max',       min: 0.90, max: 1.00 },
]

// Fracción de la FC de reserva; null si faltan datos o no son coherentes
export function heartRateReserve(hr: number | null, maxHr: number | null, restingHr: number | null): number | null {
  if (!hr || !maxHr || !restingHr || maxHr <= restingHr) return null
  return (hr - restingHr) / (maxHr - restingHr)
}

export function classifyHeartRate(hr: number, maxHr: number, restingHr: number): string | null {
  const hrr = heartRateReserve(hr, maxHr, restingHr)
  if (hrr === null) return null
  const z = HR_ZONES.find(z => hrr < z.max) ?? HR_ZONES[HR_ZONES.length - 1]
  return `${z.zone} — ${z.name}`
}

// Peso de Banister (TRIMP): crece de forma exponencial con la intensidad
const trimpWeight = (hrr: number): number => hrr * Math.exp(1.92 * hrr)

// hrTSS a partir de la FC media: TRIMP normalizado para que 1 h en el umbral = 100.
// Wahoo solo da la FC media (no la serie), así que en sesiones de series se infravalora algo.
export function estimateHrTss(
  seconds: number | null, hrAvg: number | null, maxHr: number | null, restingHr: number | null
): number | null {
  const hrr = heartRateReserve(hrAvg, maxHr, restingHr)
  if (!seconds || hrr === null || hrr <= 0) return null
  return Math.round((seconds / 3600) * hrTssPerHour(hrr))
}

// hrTSS que suma una hora a una fracción de la FC de reserva dada (100 en el umbral)
export function hrTssPerHour(hrr: number): number {
  if (hrr <= 0) return 0
  const x = Math.min(hrr, 1.1)
  return (trimpWeight(x) / trimpWeight(HR_THRESHOLD_HRR)) * 100
}

// ─── Carga de un entreno ─────────────────────────────────────────────────────

export interface LoadProfile {
  ftp: number | null
  maxHr: number | null
  restingHr: number | null
}

// power: TSS de Wahoo · power_estimated: NP + FTP del perfil · hr: hrTSS con la FC media
export type TssSource = 'power' | 'power_estimated' | 'hr'

export interface WorkoutLoad {
  tss: number | null
  estimated: boolean          // true salvo que el TSS venga de Wahoo
  source: TssSource | null
}

// Prioridad: TSS de Wahoo → estimado con NP y FTP → hrTSS (entrenos sin potencia, p. ej. rodillo con pulsómetro)
export function workoutTss(workout: WahooWorkout, profile: LoadProfile | null | undefined): WorkoutLoad {
  const s = workout.summary
  if (s?.tss) return { tss: s.tss, estimated: false, source: 'power' }

  const seconds = s?.durationActiveSeconds ?? workout.durationMinutes * 60
  const powerTss = estimateTss(seconds, s?.normalizedPower ?? null, profile?.ftp)
  if (powerTss !== null) return { tss: powerTss, estimated: true, source: 'power_estimated' }

  const hrTss = estimateHrTss(seconds, s?.heartRateAvg ?? null, profile?.maxHr ?? null, profile?.restingHr ?? null)
  if (hrTss !== null) return { tss: hrTss, estimated: true, source: 'hr' }

  return { tss: null, estimated: false, source: null }
}
