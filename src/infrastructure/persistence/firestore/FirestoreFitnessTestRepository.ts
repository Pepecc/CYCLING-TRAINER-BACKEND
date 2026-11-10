import { Firestore } from 'firebase-admin/firestore'
import { FitnessTestResultProps } from '../../../domain/testing/fitnessTest'
import { FitnessTestRepository } from '../../../domain/testing/FitnessTestRepository'
import { fitnessTestsCol } from './paths'

type FitnessTestData = Omit<FitnessTestResultProps, 'id' | 'userId'>

export class FirestoreFitnessTestRepository implements FitnessTestRepository {
  constructor(private readonly db: Firestore) {}

  async save(r: FitnessTestResultProps): Promise<void> {
    const { id, userId, ...data } = r
    await fitnessTestsCol(this.db, userId).doc(id).set(data satisfies FitnessTestData)
  }

  async findAll(userId: string): Promise<FitnessTestResultProps[]> {
    const snap = await fitnessTestsCol(this.db, userId).orderBy('date', 'desc').get()
    // Same-day tests: the last one recorded first (sorted here to avoid a composite index)
    return snap.docs
      .map(d => ({ ...(d.data() as FitnessTestData), id: d.id, userId }))
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
  }
}
