import { Firestore } from 'firebase-admin/firestore'
import { DailyCheckIn, DailyCheckInProps } from '../../../domain/wellness/DailyCheckIn'
import { CheckInRepository } from '../../../domain/wellness/CheckInRepository'
import { checkInsCol } from './paths'

type CheckInData = Omit<DailyCheckInProps, 'userId'>

// The document id is the date: one check-in per day, saving again overwrites it
export class FirestoreCheckInRepository implements CheckInRepository {
  constructor(private readonly db: Firestore) {}

  async save(c: DailyCheckIn): Promise<void> {
    const data: CheckInData = { date: c.date, ...c.fields(), createdAt: c.createdAt, updatedAt: c.updatedAt }
    await checkInsCol(this.db, c.userId).doc(c.date).set(data)
  }

  async findByDate(userId: string, date: string): Promise<DailyCheckIn | null> {
    const snap = await checkInsCol(this.db, userId).doc(date).get()
    return snap.exists ? new DailyCheckIn({ ...(snap.data() as CheckInData), userId }) : null
  }

  async findBetween(userId: string, fromKey: string, toKey: string): Promise<DailyCheckIn[]> {
    const snap = await checkInsCol(this.db, userId)
      .where('date', '>=', fromKey)
      .where('date', '<=', toKey)
      .orderBy('date', 'asc')
      .get()
    return snap.docs.map(d => new DailyCheckIn({ ...(d.data() as CheckInData), userId }))
  }

  async delete(userId: string, date: string): Promise<void> {
    await checkInsCol(this.db, userId).doc(date).delete()
  }
}
