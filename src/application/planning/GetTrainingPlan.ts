import { PlannedWorkout, PlanValidationError } from '../../domain/planning/PlannedWorkout'
import { PlannedWorkoutRepository } from '../../domain/planning/PlannedWorkoutRepository'
import { CyclistProfileRepository } from '../../domain/profile/CyclistProfileRepository'
import { addDays, dayKey } from '../../domain/training/calendar'

export const DEFAULT_PLAN_DAYS = 14
export const MAX_PLAN_DAYS = 366

export interface TrainingPlan {
  from: string
  to: string
  workouts: PlannedWorkout[]
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/

export class GetTrainingPlan {
  constructor(
    private readonly plannedWorkouts: PlannedWorkoutRepository,
    private readonly profiles: CyclistProfileRepository
  ) {}

  // from defaults to today; to defaults to from + 13 days. Throws PlanValidationError.
  async execute(userId: string, from?: string | null, to?: string | null): Promise<TrainingPlan> {
    const fromKey = from || dayKey(new Date())
    const toKey = to || addDays(fromKey, DEFAULT_PLAN_DAYS - 1)

    for (const key of [fromKey, toKey]) {
      if (!DATE_KEY.test(key) || Number.isNaN(new Date(`${key}T12:00:00Z`).getTime())) {
        throw new PlanValidationError(`Fecha no válida: ${key} (formato AAAA-MM-DD)`)
      }
    }
    if (toKey < fromKey) throw new PlanValidationError('La fecha final es anterior a la inicial')
    if (toKey > addDays(fromKey, MAX_PLAN_DAYS - 1)) {
      throw new PlanValidationError(`El rango no puede superar ${MAX_PLAN_DAYS} días`)
    }

    const [workouts, profile] = await Promise.all([
      this.plannedWorkouts.findBetween(userId, fromKey, toKey),
      this.profiles.findByUserId(userId),
    ])
    // The stored TSS used the profile at save time; re-estimate with the current FTP / HR
    workouts.forEach(w => w.recalculateLoad(profile))
    return { from: fromKey, to: toKey, workouts }
  }
}
