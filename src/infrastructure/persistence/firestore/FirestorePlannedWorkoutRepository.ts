import { Firestore } from 'firebase-admin/firestore'
import { PlannedWorkout, PlannedWorkoutProps } from '../../../domain/planning/PlannedWorkout'
import { PlannedWorkoutRepository } from '../../../domain/planning/PlannedWorkoutRepository'
import { plannedWorkoutsCol } from './paths'

type PlannedWorkoutData = Omit<PlannedWorkoutProps, 'id' | 'userId'>

const BATCH_LIMIT = 500   // Firestore max writes per batch

export class FirestorePlannedWorkoutRepository implements PlannedWorkoutRepository {
  constructor(private readonly db: Firestore) {}

  async saveMany(workouts: PlannedWorkout[]): Promise<void> {
    for (let i = 0; i < workouts.length; i += BATCH_LIMIT) {
      const batch = this.db.batch()
      for (const w of workouts.slice(i, i + BATCH_LIMIT)) {
        batch.set(plannedWorkoutsCol(this.db, w.userId).doc(w.id), this.toData(w))
      }
      await batch.commit()
    }
  }

  async findById(userId: string, id: string): Promise<PlannedWorkout | null> {
    const snap = await plannedWorkoutsCol(this.db, userId).doc(id).get()
    return snap.exists ? this.toEntity(userId, id, snap.data() as PlannedWorkoutData) : null
  }

  async findBetween(userId: string, fromKey: string, toKey: string): Promise<PlannedWorkout[]> {
    const snap = await plannedWorkoutsCol(this.db, userId)
      .where('date', '>=', fromKey)
      .where('date', '<=', toKey)
      .orderBy('date', 'asc')
      .get()
    // Same-day workouts in creation order (sorted here to avoid a composite index)
    return snap.docs
      .map(d => this.toEntity(userId, d.id, d.data() as PlannedWorkoutData))
      .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt))
  }

  async delete(userId: string, id: string): Promise<void> {
    await plannedWorkoutsCol(this.db, userId).doc(id).delete()
  }

  private toData(w: PlannedWorkout): PlannedWorkoutData {
    return {
      date: w.date,
      title: w.title,
      focus: w.focus,
      environment: w.environment,
      description: w.description,
      blocks: w.blocks,
      durationMinutes: w.durationMinutes,
      plannedTss: w.plannedTss,
      status: w.status,
      notes: w.notes,
      source: w.source,
      externalId: w.externalId,
      adaptation: w.adaptation,
      statusSource: w.statusSource,
      completion: w.completion,
      testProtocol: w.testProtocol,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    }
  }

  private toEntity(userId: string, id: string, data: PlannedWorkoutData): PlannedWorkout {
    // Workouts saved before 7.7 have no externalId, before 7.8 no adaptation and before 7.9 no link with Wahoo
    // (until then every status other than 'planned' was set by hand)
    return new PlannedWorkout({
      ...data,
      externalId: data.externalId ?? null,
      adaptation: data.adaptation ?? null,
      statusSource: data.statusSource ?? (data.status === 'planned' ? null : 'manual'),
      completion: data.completion ?? null,
      testProtocol: data.testProtocol ?? null,
      id,
      userId,
    })
  }
}
