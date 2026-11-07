import { PlannedWorkout } from '../../domain/planning/PlannedWorkout'
import { PlannedWorkoutRepository } from '../../domain/planning/PlannedWorkoutRepository'
import { DateRange, reconcilePlan, reconcileRange } from '../../domain/planning/planCompliance'
import { CyclistProfileRepository } from '../../domain/profile/CyclistProfileRepository'
import { WahooWorkout } from '../../domain/wahoo/WahooWorkout'
import { WorkoutRepository } from '../../domain/wahoo/WorkoutRepository'
import { addDays, dayKey } from '../../domain/training/calendar'
import { SyncWahooWorkouts } from '../wahoo/SyncWahooWorkouts'
import { WahooNotConnectedError } from '../../infrastructure/wahoo/WahooOAuthService'

export interface ReconcileOutcome {
  range: DateRange | null      // parte enlazada (hasta mañana y como mucho 60 días atrás)
  linked: boolean              // false: Wahoo no conectado o sin entrenos sincronizados (no se toca nada)
  planned: PlannedWorkout[]    // entrenos planificados del rango, ya enlazados (vacío si linked es false)
  changed: PlannedWorkout[]
  unplanned: WahooWorkout[]    // entrenos de bici del rango sin planificar
}

// Enlaza los entrenos planificados con los entrenos de Wahoo y guarda los estados (hecho, parcial, saltado)
export class ReconcilePlan {
  constructor(
    private readonly syncWorkouts: SyncWahooWorkouts,
    private readonly workouts: WorkoutRepository,
    private readonly plannedWorkouts: PlannedWorkoutRepository,
    private readonly profiles: CyclistProfileRepository
  ) {}

  async execute(userId: string, from: string, to: string): Promise<ReconcileOutcome> {
    const today = dayKey(new Date())
    const range = reconcileRange(from, to, today)
    const none: ReconcileOutcome = { range, linked: false, planned: [], changed: [], unplanned: [] }
    if (!range) return none

    try {
      await this.syncWorkouts.execute(userId)
    } catch (err) {
      // Without Wahoo nothing can be linked: a past day without data is not a skipped workout
      if (!(err instanceof WahooNotConnectedError)) console.warn(`Plan reconciliation skipped for ${userId}:`, (err as Error).message)
      return none
    }
    if (!(await this.workouts.getSyncState(userId))) return none

    // One day of margin on each side for workouts moved to the previous or next day
    const lo = addDays(range.from, -1)
    const hi = addDays(range.to, 1)
    const [planned, actuals, profile] = await Promise.all([
      this.plannedWorkouts.findBetween(userId, lo, hi),
      this.workouts.findSince(userId, new Date(`${addDays(lo, -1)}T00:00:00Z`)),
      this.profiles.findByUserId(userId),
    ])
    planned.forEach(w => w.recalculateLoad(profile))
    const inWindow = actuals.filter(a => {
      const d = dayKey(new Date(a.startedAt))
      return d >= lo && d <= hi
    })

    const { changed, unplanned } = reconcilePlan(planned, inWindow, profile, today, range)
    if (changed.length) await this.plannedWorkouts.saveMany(changed)
    const inRange = planned.filter(w => w.date >= range.from && w.date <= range.to)
    return { range, linked: true, planned: inRange, changed, unplanned }
  }
}
