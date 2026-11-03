import { Firestore, Timestamp } from 'firebase-admin/firestore'
import { OAuthStateRepository } from '../../../domain/wahoo/OAuthStateRepository'
import { oauthStatesCol } from './paths'

// expiresAt is a Timestamp so a Firestore TTL policy can purge stale states in production.
// The expiry is still checked here: TTL deletion is not immediate (and the emulator ignores it).
export class FirestoreOAuthStateRepository implements OAuthStateRepository {
  constructor(private readonly db: Firestore) {}

  async create(state: string, userId: string, ttlMs: number): Promise<void> {
    await oauthStatesCol(this.db).doc(state).create({
      userId,
      expiresAt: Timestamp.fromMillis(Date.now() + ttlMs),
    })
  }

  async consume(state: string): Promise<string | null> {
    const ref = oauthStatesCol(this.db).doc(state)
    return this.db.runTransaction(async tx => {
      const snap = await tx.get(ref)
      if (!snap.exists) return null
      tx.delete(ref)
      const expiresAt = snap.get('expiresAt') as Timestamp
      return expiresAt.toMillis() > Date.now() ? (snap.get('userId') as string) : null
    })
  }
}
