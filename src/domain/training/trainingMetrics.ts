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

// TSS de Wahoo si existe; si no, estimado a partir de NP y el FTP del perfil
export function workoutTss(workout: WahooWorkout, ftp: number | null | undefined): { tss: number | null; estimated: boolean } {
  const s = workout.summary
  if (s?.tss) return { tss: s.tss, estimated: false }
  const seconds = s?.durationActiveSeconds ?? workout.durationMinutes * 60
  const tss = estimateTss(seconds, s?.normalizedPower ?? null, ftp)
  return { tss, estimated: tss !== null }
}
