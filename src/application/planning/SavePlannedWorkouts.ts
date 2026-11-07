import { PlannedWorkout, PlannedWorkoutInput, PlanSource, PlanValidationError } from '../../domain/planning/PlannedWorkout'
import { PlannedWorkoutRepository } from '../../domain/planning/PlannedWorkoutRepository'
import { CyclistProfileRepository } from '../../domain/profile/CyclistProfileRepository'

export const MAX_WORKOUTS_PER_SAVE = 21

export class SavePlannedWorkouts {
  constructor(
    private readonly plannedWorkouts: PlannedWorkoutRepository,
    private readonly profiles: CyclistProfileRepository
  ) {}

  // All or nothing: if any workout is invalid, nothing is saved. Throws PlanValidationError.
  async execute(userId: string, inputs: PlannedWorkoutInput[], source: PlanSource): Promise<PlannedWorkout[]> {
    if (inputs.length === 0) throw new PlanValidationError('No hay entrenos que guardar')
    if (inputs.length > MAX_WORKOUTS_PER_SAVE) {
      throw new PlanValidationError(`Como máximo ${MAX_WORKOUTS_PER_SAVE} entrenos a la vez`)
    }

    const profile = await this.profiles.findByUserId(userId)
    const workouts = inputs.map((input, i) => {
      try {
        return PlannedWorkout.create(userId, input, source, profile)
      } catch (err) {
        if (err instanceof PlanValidationError && inputs.length > 1) {
          throw new PlanValidationError(`Entreno ${i + 1}: ${err.message}`)
        }
        throw err
      }
    })

    await this.plannedWorkouts.saveMany(workouts)
    return workouts
  }
}
