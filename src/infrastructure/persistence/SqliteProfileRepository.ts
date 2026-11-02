import Database from 'better-sqlite3'
import { CyclistProfile, Experience } from '../../domain/profile/CyclistProfile'
import { CyclistProfileRepository } from '../../domain/profile/CyclistProfileRepository'

interface ProfileRow {
  user_id: string
  ftp: number | null
  weight_kg: number | null
  hours_per_week: number | null
  goal: string | null
  experience: Experience
  max_hr: number | null
  resting_hr: number | null
  available_days: string | null
  target_events: string | null
  limitations: string | null
  updated_at: string
}

export class SqliteProfileRepository implements CyclistProfileRepository {
  constructor(private readonly db: Database.Database) {}

  async findByUserId(userId: string): Promise<CyclistProfile | null> {
    const row = this.db
      .prepare('SELECT * FROM cyclist_profiles WHERE user_id = ?')
      .get(userId) as ProfileRow | undefined
    return row ? this.toEntity(row) : null
  }

  async save(profile: CyclistProfile): Promise<void> {
    this.db.prepare(`
      INSERT INTO cyclist_profiles
        (user_id, ftp, weight_kg, hours_per_week, goal, experience,
         max_hr, resting_hr, available_days, target_events, limitations, updated_at)
      VALUES
        (@userId, @ftp, @weightKg, @hoursPerWeek, @goal, @experience,
         @maxHr, @restingHr, @availableDays, @targetEvents, @limitations, @updatedAt)
      ON CONFLICT(user_id) DO UPDATE SET
        ftp            = excluded.ftp,
        weight_kg      = excluded.weight_kg,
        hours_per_week = excluded.hours_per_week,
        goal           = excluded.goal,
        experience     = excluded.experience,
        max_hr         = excluded.max_hr,
        resting_hr     = excluded.resting_hr,
        available_days = excluded.available_days,
        target_events  = excluded.target_events,
        limitations    = excluded.limitations,
        updated_at     = excluded.updated_at
    `).run({
      userId: profile.userId,
      ftp: profile.ftp,
      weightKg: profile.weightKg,
      hoursPerWeek: profile.hoursPerWeek,
      goal: profile.goal,
      experience: profile.experience,
      maxHr: profile.maxHr,
      restingHr: profile.restingHr,
      availableDays: profile.availableDays,
      targetEvents: profile.targetEvents,
      limitations: profile.limitations,
      updatedAt: profile.updatedAt,
    })
  }

  private toEntity(row: ProfileRow): CyclistProfile {
    return new CyclistProfile({
      userId: row.user_id,
      ftp: row.ftp,
      weightKg: row.weight_kg,
      hoursPerWeek: row.hours_per_week,
      goal: row.goal,
      experience: row.experience,
      maxHr: row.max_hr,
      restingHr: row.resting_hr,
      availableDays: row.available_days,
      targetEvents: row.target_events,
      limitations: row.limitations,
      updatedAt: row.updated_at,
    })
  }
}
