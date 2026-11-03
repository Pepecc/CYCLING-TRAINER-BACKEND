import { Firestore } from 'firebase-admin/firestore'
import { WahooWorkout } from '../../../domain/wahoo/WahooWorkout'
import { WorkoutRepository, WorkoutSyncState } from '../../../domain/wahoo/WorkoutRepository'
import { workoutsCol, privateDoc } from './paths'

// Each workout is stored with its WahooWorkout fields plus startedAtUtc, a normalized
// ISO string (sorts chronologically) used for date-range queries and ordering.
type WorkoutData = WahooWorkout & { startedAtUtc: string; syncedAt: string }

const BATCH_LIMIT = 500   // Firestore max writes per batch

export class FirestoreWorkoutRepository implements WorkoutRepository {
  constructor(private readonly db: Firestore) {}

  async upsertMany(userId: string, workouts: WahooWorkout[]): Promise<void> {
    const col = workoutsCol(this.db, userId)
    const syncedAt = new Date().toISOString()
    for (let i = 0; i < workouts.length; i += BATCH_LIMIT) {
      const batch = this.db.batch()
      for (const w of workouts.slice(i, i + BATCH_LIMIT)) {
        const data: WorkoutData = { ...w, startedAtUtc: new Date(w.startedAt).toISOString(), syncedAt }
        batch.set(col.doc(String(w.id)), data)
      }
      await batch.commit()
    }
  }

  async findSince(userId: string, since: Date): Promise<WahooWorkout[]> {
    const snap = await workoutsCol(this.db, userId)
      .where('startedAtUtc', '>=', since.toISOString())
      .orderBy('startedAtUtc', 'desc')
      .get()
    return snap.docs.map(d => this.toEntity(d.data() as WorkoutData))
  }

  async findPage(userId: string, offset: number, limit: number): Promise<WahooWorkout[]> {
    const snap = await workoutsCol(this.db, userId)
      .orderBy('startedAtUtc', 'desc')
      .offset(offset)
      .limit(limit)
      .get()
    return snap.docs.map(d => this.toEntity(d.data() as WorkoutData))
  }

  async getSyncState(userId: string): Promise<WorkoutSyncState | null> {
    const lastSyncedAt = (await privateDoc(this.db, userId, 'workoutSync').get()).get('lastSyncedAt') as string | undefined
    return lastSyncedAt ? { lastSyncedAt } : null
  }

  async saveSyncState(userId: string, state: WorkoutSyncState): Promise<void> {
    await privateDoc(this.db, userId, 'workoutSync').set({ lastSyncedAt: state.lastSyncedAt })
  }

  async deleteAllForUser(userId: string): Promise<void> {
    await this.db.recursiveDelete(workoutsCol(this.db, userId))
    await privateDoc(this.db, userId, 'workoutSync').delete()
  }

  private toEntity(data: WorkoutData): WahooWorkout {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { startedAtUtc, syncedAt, ...workout } = data
    return workout
  }
}
