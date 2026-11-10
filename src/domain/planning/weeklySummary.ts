import type { PlannedWorkout, WorkoutFocus, PlannedStatus } from './PlannedWorkout'
import type { SeasonWeek, WeekType, SeasonPhaseKind } from '../events/seasonPlan'
import type { ReadinessLevel } from '../wellness/DailyCheckIn'
import { addDays, daysBetween } from '../training/calendar'

// Resumen de una semana (lunes a domingo): planificado frente a hecho, cómo se ha encontrado el ciclista,
// cómo cambia la forma y una recomendación para la semana siguiente. Reglas sencillas y explicables:
// el coach las comenta y ajusta el plan con el ciclista.

export const QUALITY_FOCUSES: WorkoutFocus[] = ['sweet_spot', 'threshold', 'vo2max', 'anaerobic', 'sprint', 'test', 'race']

export interface ActualSession {
  id: number
  date: string
  name: string
  minutes: number
  tss: number | null
  inPlan: boolean          // enlazado con un entreno planificado
}

export interface FitnessSnapshot { ctl: number; atl: number; tsb: number }

export interface WellnessWeek {
  days: number
  fatigue: number | null
  sleepHours: number | null
  feeling: number | null
  soreness: number | null
  levels: ReadinessLevel[]
}

export interface WeeklySummaryInput {
  monday: string
  today: string
  linked: boolean                       // estados enlazados con Wahoo
  planned: PlannedWorkout[]             // entrenos planificados de la semana
  actuals: ActualSession[]              // entrenos de Wahoo de la semana
  wellness: WellnessWeek
  fitnessStart: FitnessSnapshot         // al final del domingo anterior
  fitnessEnd: FitnessSnapshot           // al final del domingo (o de hoy, si la semana está en curso)
  season: SeasonWeek | null
  nextSeason: SeasonWeek | null
  nextWeek: { sessions: number; tss: number; minutes: number }
  baseWeeklyTss: number | null          // TSS medio de las 4 semanas anteriores
}

export type RecommendationLevel = 'progress' | 'maintain' | 'reduce' | 'recover'

export interface WeeklySummary {
  monday: string
  sunday: string
  complete: boolean
  linked: boolean
  planned: { sessions: number; minutes: number; tss: number }
  done: {
    sessions: number                    // entrenos realizados (Wahoo, o marcados a mano sin Wahoo)
    minutes: number
    tss: number
    estimatedTss: number                // parte del TSS que es el previsto de sesiones marcadas a mano sin datos
    unplanned: ActualSession[]
  }
  statuses: Record<PlannedStatus, number>
  compliance: { sessionsPercent: number | null; tssPercent: number | null }
  keySessions: Array<{ id: string; date: string; title: string; focus: WorkoutFocus; status: PlannedStatus }>
  remaining: { sessions: number; tss: number }   // lo que queda de la semana en curso
  wellness: WellnessWeek
  fitness: { start: FitnessSnapshot; end: FitnessSnapshot; ctlChange: number }
  season: { type: WeekType; phase: SeasonPhaseKind; loadPercent: number } | null
  nextSeason: { type: WeekType; phase: SeasonPhaseKind; loadPercent: number } | null
  nextWeek: { sessions: number; tss: number; minutes: number; targetTss: [number, number] | null }
  recommendation: { level: RecommendationLevel; headline: string; points: string[] }
}

const NEXT_FACTOR: Record<RecommendationLevel, [number, number]> = {
  progress: [1.05, 1.10],
  maintain: [0.95, 1.05],
  reduce: [0.85, 0.95],
  recover: [0.5, 0.65],
}
// Weeks of the season plan that set the next week's load on their own
const SEASON_FACTOR: Partial<Record<WeekType, [number, number]>> = {
  deload: [0.6, 0.7],
  taper: [0.5, 0.6],
  race: [0.4, 0.6],
  recovery: [0.3, 0.5],
}
const SEASON_WEEK_LABEL: Partial<Record<WeekType, string>> = {
  deload: 'descarga', taper: 'taper', race: 'semana de carrera', recovery: 'recuperación',
}

export function buildWeeklySummary(i: WeeklySummaryInput): WeeklySummary {
  const sunday = addDays(i.monday, 6)
  const complete = i.today > sunday
  const sessions = i.planned.filter(w => w.focus !== 'rest')

  const statuses: Record<PlannedStatus, number> = { planned: 0, done: 0, partial: 0, skipped: 0 }
  sessions.forEach(w => statuses[w.status]++)

  // Done: everything recorded in Wahoo; without Wahoo data, the sessions marked done by hand (with their planned TSS)
  const linkedIds = new Set(sessions.flatMap(w => w.completion?.wahooWorkoutIds ?? []))
  const actuals = i.actuals.map(a => ({ ...a, inPlan: a.inPlan || linkedIds.has(a.id) }))
  const manual = sessions.filter(w => (w.status === 'done' || w.status === 'partial') && !w.completion)
  const estimatedTss = manual.reduce((s, w) => s + (w.plannedTss ?? 0) * (w.status === 'partial' ? 0.5 : 1), 0)
  const done = {
    sessions: actuals.length + manual.length,
    minutes: actuals.reduce((s, a) => s + a.minutes, 0) + manual.reduce((s, w) => s + (w.durationMinutes ?? 0) * (w.status === 'partial' ? 0.5 : 1), 0),
    tss: Math.round(actuals.reduce((s, a) => s + (a.tss ?? 0), 0) + estimatedTss),
    estimatedTss: Math.round(estimatedTss),
    unplanned: actuals.filter(a => !a.inPlan),
  }

  const planned = {
    sessions: sessions.length,
    minutes: sessions.reduce((s, w) => s + (w.durationMinutes ?? 0), 0),
    tss: Math.round(sessions.reduce((s, w) => s + (w.plannedTss ?? 0), 0)),
  }

  // Compliance over the sessions already decided (a pending session today does not count yet)
  const decided = statuses.done + statuses.partial + statuses.skipped
  const sessionsPercent = decided ? Math.round(((statuses.done + 0.5 * statuses.partial) / decided) * 100) : null
  const dueTss = sessions
    .filter(w => w.date < i.today || (w.date === i.today && w.status !== 'planned'))
    .reduce((s, w) => s + (w.plannedTss ?? 0), 0)
  const tssPercent = dueTss > 0 ? Math.round((done.tss / dueTss) * 100) : null

  const pending = sessions.filter(w => w.status === 'planned' && w.date >= i.today)
  const remaining = { sessions: pending.length, tss: Math.round(pending.reduce((s, w) => s + (w.plannedTss ?? 0), 0)) }

  const keySessions = sessions
    .filter(w => QUALITY_FOCUSES.includes(w.focus))
    .map(w => ({ id: w.id, date: w.date, title: w.title, focus: w.focus, status: w.status }))

  const ctlChange = Math.round((i.fitnessEnd.ctl - i.fitnessStart.ctl) * 10) / 10
  const pick = (w: SeasonWeek | null) => (w ? { type: w.type, phase: w.phase, loadPercent: w.loadPercent } : null)

  const recommendation = recommend(i, { complete, sessionsPercent, tssPercent, decided, keySessions, done, ctlChange, remaining })

  // Orientative TSS for next week, from this week's real load (or the recent average while it is in progress)
  const base = complete && done.tss > 0 ? done.tss : i.baseWeeklyTss
  const factor = (i.nextSeason && SEASON_FACTOR[i.nextSeason.type]) || NEXT_FACTOR[recommendation.level]
  const targetTss: [number, number] | null = base
    ? [Math.round((base * factor[0]) / 5) * 5, Math.round((base * factor[1]) / 5) * 5]
    : null
  if (targetTss && i.nextWeek.sessions > 0) {
    const t = i.nextWeek.tss
    if (t > targetTss[1] * 1.1) recommendation.points.push(`El plan de la semana que viene suma ${t} TSS, por encima de lo orientativo (${targetTss[0]}-${targetTss[1]}): conviene recortarlo.`)
    else if (t < targetTss[0] * 0.85) recommendation.points.push(`El plan de la semana que viene suma ${t} TSS, por debajo de lo orientativo (${targetTss[0]}-${targetTss[1]}).`)
    else recommendation.points.push(`El plan de la semana que viene (${t} TSS) encaja con lo orientativo (${targetTss[0]}-${targetTss[1]}).`)
  } else if (targetTss) {
    recommendation.points.push(`La semana que viene no tiene entrenos planificados: orientativo ${targetTss[0]}-${targetTss[1]} TSS.`)
  }

  return {
    monday: i.monday,
    sunday,
    complete,
    linked: i.linked,
    planned,
    done,
    statuses,
    compliance: { sessionsPercent, tssPercent },
    keySessions,
    remaining,
    wellness: i.wellness,
    fitness: { start: i.fitnessStart, end: i.fitnessEnd, ctlChange },
    season: pick(i.season),
    nextSeason: pick(i.nextSeason),
    nextWeek: { ...i.nextWeek, targetTss },
    recommendation,
  }
}

interface Facts {
  complete: boolean
  sessionsPercent: number | null
  tssPercent: number | null
  decided: number
  keySessions: WeeklySummary['keySessions']
  done: WeeklySummary['done']
  ctlChange: number
  remaining: { sessions: number; tss: number }
}

function recommend(i: WeeklySummaryInput, f: Facts): WeeklySummary['recommendation'] {
  const w = i.wellness
  const rough = w.levels.filter(l => l === 'rest').length
  const caution = w.levels.filter(l => l === 'caution').length
  const tsb = i.fitnessEnd.tsb

  const fatigued = (w.fatigue !== null && w.fatigue >= 4) || rough >= 2 || tsb < -30
  const tired = (w.fatigue !== null && w.fatigue >= 3.5) || rough + caution >= 3 || tsb < -20
  const fastRamp = f.ctlChange > 7
  const overdone = f.tssPercent !== null && f.tssPercent > 115
  const lowCompliance = f.decided >= 2 && f.sessionsPercent !== null && f.sessionsPercent < 60

  const points: string[] = []
  let level: RecommendationLevel
  let headline: string

  if (fatigued) {
    level = 'recover'
    headline = 'Toca descargar: hay demasiada fatiga acumulada.'
    if (w.fatigue !== null && w.fatigue >= 4) points.push(`Cansancio medio de ${w.fatigue}/5 en los check-ins.`)
    if (rough >= 2) points.push(`${rough} días con varias señales de fatiga (check-in en rojo).`)
    if (tsb < -30) points.push(`TSB de ${Math.round(tsb)}: por debajo de −30 hay riesgo de sobrecarga.`)
    points.push('Semana que viene: bajar el volumen un 40-50 %, un solo toque corto de intensidad y prioridad al sueño.')
  } else if (fastRamp || (tired && overdone)) {
    level = 'reduce'
    headline = 'Mantén o baja un poco la carga: ha subido muy rápido.'
    if (fastRamp) points.push(`El CTL ha subido ${f.ctlChange} puntos en la semana (más de 7 es una subida muy rápida).`)
    if (overdone) points.push(`Has hecho el ${f.tssPercent} % del TSS previsto.`)
  } else if (lowCompliance) {
    level = 'maintain'
    headline = 'Repite la carga en lugar de subirla: la semana se ha quedado a medias.'
    points.push(`Cumplimiento del ${f.sessionsPercent} % de las sesiones.`)
    points.push('Si ha sido por falta de tiempo, mejor un plan más corto que se pueda cumplir (revisa horas y días disponibles).')
  } else if (tired) {
    level = 'maintain'
    headline = 'Mantén la carga: hay algo de fatiga.'
    if (w.fatigue !== null) points.push(`Cansancio medio de ${w.fatigue}/5.`)
    if (tsb < -20) points.push(`TSB de ${Math.round(tsb)}.`)
  } else {
    level = 'progress'
    headline = 'Buena semana: puedes subir la carga un 5-10 %.'
    if (f.sessionsPercent !== null) points.push(`Cumplimiento del ${f.sessionsPercent} % de las sesiones.`)
    if (tsb > 10) points.push(`Llegas fresco (TSB +${Math.round(tsb)}): margen para una semana más exigente.`)
  }

  // The season plan sets the type of the next week (deload, taper, race, recovery)
  const next = i.nextSeason?.type
  const seasonLabel = next ? SEASON_WEEK_LABEL[next] : undefined
  if (seasonLabel && level !== 'recover') {
    headline = `La semana que viene toca ${seasonLabel} según el plan de temporada.`
    points.push(`Plan de temporada: ${seasonLabel} al ${i.nextSeason!.loadPercent} % de una semana normal.`)
  } else if (level === 'recover' && next === 'load') {
    points.push('El plan de temporada marca semana de carga: conviene adelantar la descarga y retomar la carga después.')
  }

  const missed = f.keySessions.filter(k => k.status === 'skipped')
  if (missed.length) points.push(`Sesiones clave sin hacer: ${missed.map(k => k.title).join(', ')}. No las recuperes todas de golpe.`)
  if (f.done.unplanned.length) {
    points.push(`${f.done.unplanned.length} entreno(s) fuera del plan (${Math.round(f.done.unplanned.reduce((s, a) => s + (a.tss ?? 0), 0))} TSS).`)
  }
  if (!f.complete) {
    const left = daysBetween(i.today, addDays(i.monday, 6)) + 1
    points.unshift(`Semana en curso (quedan ${left} día${left === 1 ? '' : 's'}${f.remaining.sessions ? `, ${f.remaining.sessions} sesión(es) y ${f.remaining.tss} TSS` : ''}): la recomendación es provisional.`)
  }
  if (!i.linked) points.push('Sin Wahoo enlazado, lo hecho solo cuenta lo marcado a mano (con su TSS previsto).')
  if (w.days === 0) points.push('Sin check-ins esta semana: con ellos la recomendación tiene en cuenta el cansancio y el sueño.')

  return { level, headline, points }
}
