import { Firestore } from 'firebase-admin/firestore'
import { User } from '../../../domain/user/User'
import { UserRepository } from '../../../domain/user/UserRepository'
import { userDoc } from './paths'

interface UserData {
  email: string
  createdAt: string
}

export class FirestoreUserRepository implements UserRepository {
  // ensureExists runs on every authenticated request: remember who already exists
  private readonly known = new Set<string>()

  constructor(private readonly db: Firestore) {}

  async findById(id: string): Promise<User | null> {
    const snap = await userDoc(this.db, id).get()
    const data = snap.data() as UserData | undefined
    return data?.email ? this.toEntity(id, data) : null
  }

  async findByEmail(email: string): Promise<User | null> {
    const snap = await this.db.collection('users').where('email', '==', email).limit(1).get()
    if (snap.empty) return null
    const doc = snap.docs[0]
    return this.toEntity(doc.id, doc.data() as UserData)
  }

  async save(user: User): Promise<void> {
    await userDoc(this.db, user.id).set({ email: user.email, createdAt: user.createdAt }, { merge: true })
    this.known.add(user.id)
  }

  async ensureExists(id: string, email: string): Promise<void> {
    if (this.known.has(id)) return
    const ref = userDoc(this.db, id)
    await this.db.runTransaction(async tx => {
      const data = (await tx.get(ref)).data() as Partial<UserData> | undefined
      if (data?.email === email && data.createdAt) return
      tx.set(ref, { email, createdAt: data?.createdAt ?? new Date().toISOString() }, { merge: true })
    })
    this.known.add(id)
  }

  private toEntity(id: string, data: UserData): User {
    return new User({ id, email: data.email, createdAt: data.createdAt })
  }
}
