import { PlannedWorkoutRepository } from '../../domain/planning/PlannedWorkoutRepository'
import { PlanValidationError } from '../../domain/planning/PlannedWorkout'
import { CyclistProfileRepository } from '../../domain/profile/CyclistProfileRepository'
import { WorkoutRepository } from '../../domain/wahoo/WorkoutRepository'
import { SeasonPlan } from '../../domain/events/seasonPlan'
import { addDays, dayKey, daysBetween } from '../../domain/training/calendar'
import { workoutTss } from '../../domain/training/trainingMetrics'
import {
  FITNESS_WARMUP_DAYS, FitnessPoint, ProjectionAssessment, WeekFitness,
  assessProjection, averageWeeklyTss, projectFitness, weeklyFitness,
} from '../../domain/training/fitness'
import { GetSeasonPlan } from '../events/GetSeasonPlan'
import { ReconcilePlan } from './ReconcilePlan'

export type HorizonReason = 'request' | 'race' | 'plan' | 'default'

export interface FormProjectionResult {
  today: string
  horizon: string
  horizonReason: HorizonReason
  targetRace: { id: string; name: string; date: string } | null
  current: FitnessPoint                 // hoy al final del día (con lo hecho y lo pendiente de hoy)
  history: FitnessPoint[]               // últimos 42 días
  projection: FitnessPoint[]            // de hoy al horizonte
  weeks: WeekFitness[]                  // proyección por semanas
  assessment: ProjectionAssessment
  planEnd: string | null                // hasta dónde llega el plan detallado
  baseWeeklyTss: number | null          // TSS semanal de referencia para las semanas sin plan detallado
  wahooLinked: boolean
  notes: string[]
}

const DEFAULT_HORIZON_DAYS = 28
const MAX_HORIZON_DAYS = 366
const HISTORY_IN_RESULT = 42
const AFTER_RACE_DAYS = 7
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/

// CTL/ATL/TSB proyectados: carga real hasta hoy + plan detallado + plan de temporada hasta la carrera objetivo
export class GetFormProjection {
  constructor(
    private readonly workouts: WorkoutRepository,
    private readonly plannedWorkouts: PlannedWorkoutRepository,
    private readonly profiles: CyclistProfileRepository,
    private readonly reconcile: ReconcilePlan,
    private readonly getSeasonPlan: GetSeasonPlan
  ) {}

  // to: último día de la proyección (por defecto, una semana después de la próxima carrera A). Throws PlanValidationError.
  async execute(userId: string, to?: string | null): Promise<FormProjectionResult> {
    const today = dayKey(new Date())
    if (to && (!DATE_KEY.test(to) || Number.isNaN(Date.parse(`${to}T12:00:00Z`)))) {
      throw new PlanValidationError(`Fecha no válida: ${to} (formato AAAA-MM-DD)`)
    }
    if (to && (to <= today || to > addDays(today, MAX_HORIZON_DAYS))) {
      throw new PlanValidationError('La fecha final debe estar entre mañana y dentro de un año')
    }

    // Fresh statuses first (it also syncs Wahoo)
    const outcome = await this.reconcile.execute(userId, addDays(today, -14), today)
    const historyStart = addDays(today, -FITNESS_WARMUP_DAYS)
    const [actuals, plannedAll, profile, season] = await Promise.all([
      this.workouts.findSince(userId, new Date(`${addDays(historyStart, -1)}T00:00:00Z`)),
      this.plannedWorkouts.findBetween(userId, today, addDays(today, MAX_HORIZON_DAYS)),
      this.profiles.findByUserId(userId),
      this.loadSeason(userId),
    ])
    plannedAll.forEach(w => w.recalculateLoad(profile))

    const target = season?.targetRace ?? null
    const lastPlanned = plannedAll.length ? plannedAll[plannedAll.length - 1].date : null
    let horizon: string
    let horizonReason: HorizonReason
    if (to) { horizon = to; horizonReason = 'request' }
    else if (target) { horizon = addDays(target.endDate, AFTER_RACE_DAYS); horizonReason = 'race' }
    else if (lastPlanned && lastPlanned > addDays(today, 6)) { horizon = lastPlanned; horizonReason = 'plan' }
    else { horizon = addDays(today, DEFAULT_HORIZON_DAYS - 1); horizonReason = 'default' }
    if (horizon > addDays(today, MAX_HORIZON_DAYS)) horizon = addDays(today, MAX_HORIZON_DAYS)

    // Real load per local day (every sport counts for the fatigue)
    const actualDaily = new Map<string, number>()
    for (const a of actuals) {
      const d = dayKey(new Date(a.startedAt))
      if (d < historyStart || d > today) continue
      actualDaily.set(d, (actualDaily.get(d) ?? 0) + (workoutTss(a, profile).tss ?? 0))
    }

    // Pending planned sessions (done / partial ones are already in the real load; skipped ones did not happen)
    const plannedDaily = new Map<string, number>()
    let withoutTss = 0
    const inHorizon = plannedAll.filter(w => w.date <= horizon)
    for (const w of inHorizon) {
      if (w.status !== 'planned') continue
      if (w.plannedTss === null && w.focus !== 'rest') withoutTss++
      plannedDaily.set(w.date, (plannedDaily.get(w.date) ?? 0) + (w.plannedTss ?? 0))
    }
    const planEnd = inHorizon.length ? inHorizon[inHorizon.length - 1].date : null

    // Reference week for the days beyond the detailed plan: recent real load, or the plan's average
    let baseWeeklyTss: number | null = averageWeeklyTss(actualDaily, today)
    if (!baseWeeklyTss && planEnd && planEnd >= addDays(today, 6)) {
      const total = [...plannedDaily.values()].reduce((a, b) => a + b, 0)
      baseWeeklyTss = Math.round((total / (daysBetween(today, planEnd) + 1)) * 7)
    }
    if (!baseWeeklyTss) baseWeeklyTss = null

    const series = projectFitness({
      today, historyStart, actualDaily, plannedDaily, planEnd, horizon,
      seasonWeeks: season?.weeks ?? [],
      baseWeeklyTss,
    })
    const races = (season?.races ?? [])
      .filter(r => r.date > today && r.date <= horizon)
      .map(r => ({ id: r.raceId, name: r.name, priority: r.priority, date: r.date }))
    const assessment = assessProjection(series, races)

    const notes: string[] = []
    if (!outcome.linked) notes.push('Wahoo no está conectado o no tiene entrenos: la carga real es 0 y el CTL de partida sale bajo.')
    if (horizon > (planEnd ?? today)) {
      notes.push(baseWeeklyTss
        ? `El plan detallado llega hasta ${planEnd ?? 'hoy'}; desde ahí la proyección supone ${baseWeeklyTss} TSS por semana normal (media de las últimas 4 semanas o del plan) ajustado con el % de carga de cada semana del plan de temporada.`
        : `El plan detallado llega hasta ${planEnd ?? 'hoy'} y no hay carga reciente para estimar el resto: desde ahí la proyección supone descanso.`)
    }
    if (withoutTss) notes.push(`${withoutTss} entreno(s) planificado(s) sin TSS previsto cuentan como 0 (sin FTP ni FC en el perfil, o sin estructura).`)

    return {
      today,
      horizon,
      horizonReason,
      targetRace: target ? { id: target.id, name: target.name, date: target.date } : null,
      current: series.projection[0],
      history: series.history.slice(-HISTORY_IN_RESULT),
      projection: series.projection,
      weeks: weeklyFitness(series.projection),
      assessment,
      planEnd,
      baseWeeklyTss,
      wahooLinked: outcome.linked,
      notes,
    }
  }

  private async loadSeason(userId: string): Promise<SeasonPlan | null> {
    try {
      return await this.getSeasonPlan.execute(userId)
    } catch (err) {
      console.error('Season plan for the form projection failed:', err)
      return null
    }
  }
}
