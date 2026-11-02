import Database from 'better-sqlite3'
import { OAuthStateRepository } from '../../domain/wahoo/OAuthStateRepository'

interface OAuthStateRow {
  user_id: string
  expires_at: string
}

export class SqliteOAuthStateRepository implements OAuthStateRepository {
  constructor(private readonly db: Database.Database) {}

  async create(state: string, userId: string, ttlMs: number): Promise<void> {
    const now = new Date()
    this.db.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').run(now.toISOString())
    this.db.prepare(`
      INSERT INTO oauth_states (state, user_id, expires_at)
      VALUES (?, ?, ?)
    `).run(state, userId, new Date(now.getTime() + ttlMs).toISOString())
  }

  async consume(state: string): Promise<string | null> {
    const row = this.db
      .prepare('SELECT user_id, expires_at FROM oauth_states WHERE state = ?')
      .get(state) as OAuthStateRow | undefined
    this.db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state)
    if (!row || new Date(row.expires_at).getTime() <= Date.now()) return null
    return row.user_id
  }
}
