import { Firestore } from 'firebase-admin/firestore'
import { WahooToken } from '../../../domain/wahoo/WahooToken'
import { WahooTokenRepository } from '../../../domain/wahoo/WahooTokenRepository'
import { encryptSecret, decryptSecret } from '../tokenCipher'
import { privateDoc } from './paths'

interface WahooTokenData {
  accessToken: string     // encrypted
  refreshToken: string    // encrypted
  expiresAt: string
  createdAt: string
}

export class FirestoreWahooTokenRepository implements WahooTokenRepository {
  constructor(private readonly db: Firestore) {}

  async findByUserId(userId: string): Promise<WahooToken | null> {
    const snap = await privateDoc(this.db, userId, 'wahoo').get()
    const d = snap.data() as WahooTokenData | undefined
    if (!d) return null
    return new WahooToken({
      userId,
      accessToken: decryptSecret(d.accessToken),
      refreshToken: decryptSecret(d.refreshToken),
      expiresAt: d.expiresAt,
      createdAt: d.createdAt,
    })
  }

  async save(token: WahooToken): Promise<void> {
    const ref = privateDoc(this.db, token.userId, 'wahoo')
    // Keep the original createdAt across refreshes
    await this.db.runTransaction(async tx => {
      const existing = (await tx.get(ref)).get('createdAt') as string | undefined
      const data: WahooTokenData = {
        accessToken: encryptSecret(token.accessToken),
        refreshToken: encryptSecret(token.refreshToken),
        expiresAt: token.expiresAt,
        createdAt: existing ?? token.createdAt,
      }
      tx.set(ref, data)
    })
  }

  async deleteByUserId(userId: string): Promise<void> {
    await privateDoc(this.db, userId, 'wahoo').delete()
  }
}
