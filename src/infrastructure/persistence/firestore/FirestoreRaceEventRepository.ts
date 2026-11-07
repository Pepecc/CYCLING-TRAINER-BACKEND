import { Firestore, Query } from 'firebase-admin/firestore'
import { RaceEvent, RaceEventProps } from '../../../domain/events/RaceEvent'
import { RaceEventRepository } from '../../../domain/events/RaceEventRepository'
import { eventsCol } from './paths'

type RaceEventData = Omit<RaceEventProps, 'id' | 'userId'>

const BATCH_LIMIT = 500   // Firestore max writes per batch

export class FirestoreRaceEventRepository implements RaceEventRepository {
  constructor(private readonly db: Firestore) {}

  async saveMany(events: RaceEvent[]): Promise<void> {
    for (let i = 0; i < events.length; i += BATCH_LIMIT) {
      const batch = this.db.batch()
      for (const e of events.slice(i, i + BATCH_LIMIT)) {
        batch.set(eventsCol(this.db, e.userId).doc(e.id), this.toData(e))
      }
      await batch.commit()
    }
  }

  async findById(userId: string, id: string): Promise<RaceEvent | null> {
    const snap = await eventsCol(this.db, userId).doc(id).get()
    return snap.exists ? this.toEntity(userId, id, snap.data() as RaceEventData) : null
  }

  async findAll(userId: string): Promise<RaceEvent[]> {
    return this.run(userId, eventsCol(this.db, userId).orderBy('date', 'asc'))
  }

  async findBetween(userId: string, fromKey: string, toKey: string): Promise<RaceEvent[]> {
    return this.run(userId, eventsCol(this.db, userId)
      .where('date', '>=', fromKey)
      .where('date', '<=', toKey)
      .orderBy('date', 'asc'))
  }

  async delete(userId: string, id: string): Promise<void> {
    await eventsCol(this.db, userId).doc(id).delete()
  }

  private async run(userId: string, query: Query): Promise<RaceEvent[]> {
    const snap = await query.get()
    // Same-day races by priority (sorted here to avoid a composite index)
    return snap.docs
      .map(d => this.toEntity(userId, d.id, d.data() as RaceEventData))
      .sort((a, b) => a.date.localeCompare(b.date) || a.priority.localeCompare(b.priority))
  }

  private toData(e: RaceEvent): RaceEventData {
    return {
      name: e.name,
      date: e.date,
      days: e.days,
      priority: e.priority,
      type: e.type,
      distanceKm: e.distanceKm,
      elevationM: e.elevationM,
      location: e.location,
      goal: e.goal,
      notes: e.notes,
      result: e.result,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    }
  }

  private toEntity(userId: string, id: string, data: RaceEventData): RaceEvent {
    return new RaceEvent({ ...data, days: data.days ?? 1, id, userId })
  }
}
