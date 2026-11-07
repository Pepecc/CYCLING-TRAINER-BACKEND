import { PlannedWorkout, PlannedWorkoutNotFoundError, PlanValidationError, WorkoutVersion } from '../../domain/planning/PlannedWorkout'
import { PlannedWorkoutRepository } from '../../domain/planning/PlannedWorkoutRepository'
import { CyclistProfileRepository } from '../../domain/profile/CyclistProfileRepository'
import { adaptWorkout, parseAdaptRequest } from '../../domain/planning/adaptWorkout'

export interface AdaptPlannedWorkoutResult {
  workout: PlannedWorkout     // con la versión adaptada (guardada o solo vista previa)
  original: WorkoutVersion
  changes: string[]
  warnings: string[]
  saved: boolean
}

export class AdaptPlannedWorkout {
  constructor(
    private readonly plannedWorkouts: PlannedWorkoutRepository,
    private readonly profiles: CyclistProfileRepository
  ) {}

  // environment / availableMinutes not given → those of the current adaptation (or none).
  // availableMinutes null → no time limit. save false → preview only.
  // Throws PlannedWorkoutNotFoundError or PlanValidationError (incl. AdaptationNotPossibleError).
  async execute(
    userId: string,
    id: string,
    raw: { environment?: unknown; availableMinutes?: unknown },
    save: boolean
  ): Promise<AdaptPlannedWorkoutResult> {
    const parsed = parseAdaptRequest(raw.environment, raw.availableMinutes)
    const [workout, profile] = await Promise.all([
      this.plannedWorkouts.findById(userId, id),
      this.profiles.findByUserId(userId),
    ])
    if (!workout) throw new PlannedWorkoutNotFoundError()
    if (workout.status === 'done' || workout.status === 'partial') {
      throw new PlanValidationError('Este entreno ya está hecho: no se adapta')
    }

    workout.recalculateLoad(profile)
    const original = workout.originalVersion()
    const request = {
      environment: parsed.environment ?? workout.adaptation?.environment ?? original.environment,
      availableMinutes: parsed.availableMinutes !== undefined
        ? parsed.availableMinutes
        : workout.adaptation?.availableMinutes ?? null,
    }
    const result = adaptWorkout(original, workout.focus, request, profile)

    // The preview works on a copy so the stored workout is untouched
    const target = save ? workout : new PlannedWorkout({ ...workout })
    target.applyAdaptation(result.version, request, result, profile)
    if (save) await this.plannedWorkouts.saveMany([target])

    return { workout: target, original, changes: result.changes, warnings: result.warnings, saved: save }
  }

  // Throws PlannedWorkoutNotFoundError or PlanValidationError (not adapted)
  async restore(userId: string, id: string): Promise<PlannedWorkout> {
    const [workout, profile] = await Promise.all([
      this.plannedWorkouts.findById(userId, id),
      this.profiles.findByUserId(userId),
    ])
    if (!workout) throw new PlannedWorkoutNotFoundError()
    workout.restoreOriginal(profile)
    await this.plannedWorkouts.saveMany([workout])
    return workout
  }
}
