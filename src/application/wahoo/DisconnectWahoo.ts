import { WahooOAuthService } from '../../infrastructure/wahoo/WahooOAuthService'
import { WorkoutRepository } from '../../domain/wahoo/WorkoutRepository'

export class DisconnectWahoo {
  constructor(
    private readonly wahooService: WahooOAuthService,
    private readonly workoutRepository: WorkoutRepository
  ) {}

  // Revokes access in Wahoo, deletes the tokens and the local copy of the workouts
  async execute(userId: string): Promise<void> {
    await this.wahooService.disconnect(userId)
    await this.workoutRepository.deleteAllForUser(userId)
  }
}
