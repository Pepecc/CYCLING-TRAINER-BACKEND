import { PlannedWorkout, PlannedWorkoutNotFoundError } from '../../domain/planning/PlannedWorkout'
import { PlannedWorkoutRepository } from '../../domain/planning/PlannedWorkoutRepository'

export class DeletePlannedWorkout {
  constructor(private readonly plannedWorkouts: PlannedWorkoutRepository) {}

  // Returns the deleted workout. Throws PlannedWorkoutNotFoundError.
  async execute(userId: string, id: string): Promise<PlannedWorkout> {
    const workout = await this.plannedWorkouts.findById(userId, id)
    if (!workout) throw new PlannedWorkoutNotFoundError()
    await this.plannedWorkouts.delete(userId, id)
    return workout
  }
}
