import { WahooWorkout } from '../../domain/wahoo/WahooWorkout'
import { WorkoutRepository } from '../../domain/wahoo/WorkoutRepository'
import { SyncWahooWorkouts } from './SyncWahooWorkouts'

export class GetWahooWorkouts {
  constructor(
    private readonly syncWorkouts: SyncWahooWorkouts,
    private readonly workoutRepository: WorkoutRepository
  ) {}

  // Syncs with Wahoo (throttled) and pages over the local copy
  async execute(userId: string, page = 1, perPage = 10): Promise<WahooWorkout[]> {
    await this.syncWorkouts.execute(userId)
    const limit = Math.min(Math.max(perPage, 1), 50)
    return this.workoutRepository.findPage(userId, (Math.max(page, 1) - 1) * limit, limit)
  }
}
