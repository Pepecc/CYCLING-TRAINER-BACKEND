import { CyclistProfile, CyclistProfileFields } from '../../domain/profile/CyclistProfile'
import { CyclistProfileRepository } from '../../domain/profile/CyclistProfileRepository'

// undefined = no tocar el campo, null = borrarlo
export type UpdateProfileInput = { userId: string } & Partial<CyclistProfileFields>

export class UpdateProfile {
  constructor(private readonly profileRepository: CyclistProfileRepository) {}

  // Throws ProfileValidationError if any value is out of range
  async execute({ userId, ...patch }: UpdateProfileInput): Promise<CyclistProfile> {
    const profile = (await this.profileRepository.findByUserId(userId)) ?? CyclistProfile.create(userId)
    profile.update(patch)
    await this.profileRepository.save(profile)
    return profile
  }
}
