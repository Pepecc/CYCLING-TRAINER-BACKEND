import { Firestore } from 'firebase-admin/firestore'
import { CyclistProfile, CyclistProfileFields } from '../../../domain/profile/CyclistProfile'
import { CyclistProfileRepository } from '../../../domain/profile/CyclistProfileRepository'
import { userDoc } from './paths'

type ProfileData = CyclistProfileFields & { updatedAt: string }

// The profile lives in the `profile` field of users/{uid}
export class FirestoreProfileRepository implements CyclistProfileRepository {
  constructor(private readonly db: Firestore) {}

  async findByUserId(userId: string): Promise<CyclistProfile | null> {
    const snap = await userDoc(this.db, userId).get()
    const data = snap.get('profile') as Partial<ProfileData> | undefined
    return data ? this.toEntity(userId, data) : null
  }

  async save(profile: CyclistProfile): Promise<void> {
    const data: ProfileData = { ...profile.fields(), updatedAt: profile.updatedAt }
    await userDoc(this.db, profile.userId).set({ profile: data }, { merge: true })
  }

  private toEntity(userId: string, d: Partial<ProfileData>): CyclistProfile {
    return new CyclistProfile({
      userId,
      ftp: d.ftp ?? null,
      weightKg: d.weightKg ?? null,
      hoursPerWeek: d.hoursPerWeek ?? null,
      goal: d.goal ?? null,
      experience: d.experience ?? 'intermediate',
      maxHr: d.maxHr ?? null,
      restingHr: d.restingHr ?? null,
      availableDays: d.availableDays ?? null,
      limitations: d.limitations ?? null,
      updatedAt: d.updatedAt ?? new Date().toISOString(),
    })
  }
}
