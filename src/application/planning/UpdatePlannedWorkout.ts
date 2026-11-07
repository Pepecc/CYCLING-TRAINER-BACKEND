import { PlannedWorkout, PlannedWorkoutInput, PlannedWorkoutNotFoundError } from '../../domain/planning/PlannedWorkout'
import { PlannedWorkoutRepository } from '../../domain/planning/PlannedWorkoutRepository'
import { CyclistProfileRepository } from '../../domain/profile/CyclistProfileRepository'

export class UpdatePlannedWorkout {
  constructor(
    private readonly plannedWorkouts: PlannedWorkoutRepository,
    private readonly profiles: CyclistProfileRepository
  ) {}

  // Throws PlannedWorkoutNotFoundError or PlanValidationError
  async execute(userId: string, id: string, patch: PlannedWorkoutInput): Promise<PlannedWorkout> {
    const [workout, profile] = await Promise.all([
      this.plannedWorkouts.findById(userId, id),
      this.profiles.findByUserId(userId),
    ])
    if (!workout) throw new PlannedWorkoutNotFoundError()

    workout.update(patch, profile)
    await this.plannedWorkouts.saveMany([workout])
    return workout
  }
}
