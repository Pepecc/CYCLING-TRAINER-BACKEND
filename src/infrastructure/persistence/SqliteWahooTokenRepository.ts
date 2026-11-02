import Database from 'better-sqlite3'
import { WahooToken } from '../../domain/wahoo/WahooToken'
import { WahooTokenRepository } from '../../domain/wahoo/WahooTokenRepository'
import { encryptSecret, decryptSecret } from './tokenCipher'

interface WahooTokenRow {
  user_id: string
  access_token: string
  refresh_token: string
  expires_at: string
  created_at: string
}

export class SqliteWahooTokenRepository implements WahooTokenRepository {
  constructor(private readonly db: Database.Database) {}

  async findByUserId(userId: string): Promise<WahooToken | null> {
    const row = this.db
      .prepare('SELECT * FROM wahoo_tokens WHERE user_id = ?')
      .get(userId) as WahooTokenRow | undefined
    return row ? this.toEntity(row) : null
  }

  async save(token: WahooToken): Promise<void> {
    this.db.prepare(`
      INSERT INTO wahoo_tokens (user_id, access_token, refresh_token, expires_at, created_at)
      VALUES (@userId, @accessToken, @refreshToken, @expiresAt, @createdAt)
      ON CONFLICT(user_id) DO UPDATE SET
        access_token  = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at    = excluded.expires_at
    `).run({
      userId: token.userId,
      accessToken: encryptSecret(token.accessToken),
      refreshToken: encryptSecret(token.refreshToken),
      expiresAt: token.expiresAt,
      createdAt: token.createdAt,
    })
  }

  async deleteByUserId(userId: string): Promise<void> {
    this.db.prepare('DELETE FROM wahoo_tokens WHERE user_id = ?').run(userId)
  }

  private toEntity(row: WahooTokenRow): WahooToken {
    return new WahooToken({
      userId: row.user_id,
      accessToken: decryptSecret(row.access_token),
      refreshToken: decryptSecret(row.refresh_token),
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    })
  }
}
