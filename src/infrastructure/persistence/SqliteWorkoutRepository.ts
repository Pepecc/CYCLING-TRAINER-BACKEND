import Database from 'better-sqlite3'
import { WahooWorkout } from '../../domain/wahoo/WahooWorkout'
import { WorkoutRepository, WorkoutSyncState } from '../../domain/wahoo/WorkoutRepository'

interface WorkoutRow {
  data: string
}

interface SyncRow {
  last_synced_at: string
}

// The workout is stored as JSON (the WahooWorkout value object); started_at is
// a separate normalized column so date-range queries can use the index.
export class SqliteWorkoutRepository implements WorkoutRepository {
  constructor(private readonly db: Database.Database) {}

  async upsertMany(userId: string, workouts: WahooWorkout[]): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO workouts (user_id, id, started_at, data, synced_at)
      VALUES (@userId, @id, @startedAt, @data, @syncedAt)
      ON CONFLICT(user_id, id) DO UPDATE SET
        started_at = excluded.started_at,
        data       = excluded.data,
        synced_at  = excluded.synced_at
    `)
    const syncedAt = new Date().toISOString()
    const insertAll = this.db.transaction((items: WahooWorkout[]) => {
      for (const w of items) {
        stmt.run({
          userId,
          id: w.id,
          startedAt: new Date(w.startedAt).toISOString(),
          data: JSON.stringify(w),
          syncedAt,
        })
      }
    })
    insertAll(workouts)
  }

  async findSince(userId: string, since: Date): Promise<WahooWorkout[]> {
    const rows = this.db.prepare(`
      SELECT data FROM workouts
      WHERE user_id = ? AND started_at >= ?
      ORDER BY started_at DESC
    `).all(userId, since.toISOString()) as WorkoutRow[]
    return rows.map(r => JSON.parse(r.data) as WahooWorkout)
  }

  async findPage(userId: string, offset: number, limit: number): Promise<WahooWorkout[]> {
    const rows = this.db.prepare(`
      SELECT data FROM workouts
      WHERE user_id = ?
      ORDER BY started_at DESC
      LIMIT ? OFFSET ?
    `).all(userId, limit, offset) as WorkoutRow[]
    return rows.map(r => JSON.parse(r.data) as WahooWorkout)
  }

  async getSyncState(userId: string): Promise<WorkoutSyncState | null> {
    const row = this.db
      .prepare('SELECT last_synced_at FROM workout_sync WHERE user_id = ?')
      .get(userId) as SyncRow | undefined
    return row ? { lastSyncedAt: row.last_synced_at } : null
  }

  async saveSyncState(userId: string, state: WorkoutSyncState): Promise<void> {
    this.db.prepare(`
      INSERT INTO workout_sync (user_id, last_synced_at)
      VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET last_synced_at = excluded.last_synced_at
    `).run(userId, state.lastSyncedAt)
  }

  async deleteAllForUser(userId: string): Promise<void> {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM workouts WHERE user_id = ?').run(userId)
      this.db.prepare('DELETE FROM workout_sync WHERE user_id = ?').run(userId)
    })()
  }
}
