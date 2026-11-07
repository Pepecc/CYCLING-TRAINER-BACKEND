// One-off migration of the legacy SQLite database to Firestore.
// Usage: npm run db:migrate [-- --allow-production]
// Idempotent: re-running it overwrites the same documents. The SQLite file is opened read-only.
import 'dotenv/config'
import fs from 'fs'
import Database from 'better-sqlite3'

import { getFirestore } from '../src/infrastructure/firebase/firebaseAdmin'
import { FirestoreUserRepository } from '../src/infrastructure/persistence/firestore/FirestoreUserRepository'
import { FirestoreProfileRepository } from '../src/infrastructure/persistence/firestore/FirestoreProfileRepository'
import { FirestoreConversationRepository } from '../src/infrastructure/persistence/firestore/FirestoreConversationRepository'
import { FirestoreWahooTokenRepository } from '../src/infrastructure/persistence/firestore/FirestoreWahooTokenRepository'
import { FirestoreWorkoutRepository } from '../src/infrastructure/persistence/firestore/FirestoreWorkoutRepository'
import { decryptSecret } from '../src/infrastructure/persistence/tokenCipher'
import { User } from '../src/domain/user/User'
import { CyclistProfile, Experience } from '../src/domain/profile/CyclistProfile'
import { Conversation } from '../src/domain/chat/Conversation'
import { Message, MessageRole } from '../src/domain/chat/Message'
import { WahooToken } from '../src/domain/wahoo/WahooToken'
import { WahooWorkout } from '../src/domain/wahoo/WahooWorkout'

type Row = Record<string, unknown>

async function main(): Promise<void> {
  if (!process.env.FIRESTORE_EMULATOR_HOST && !process.argv.includes('--allow-production')) {
    throw new Error('FIRESTORE_EMULATOR_HOST no está configurada. Para migrar al Firestore real, añade --allow-production')
  }

  const dbPath = process.env.DB_PATH ?? './data/cycling_coach.db'
  if (!fs.existsSync(dbPath)) throw new Error(`No existe la base de datos SQLite ${dbPath}`)
  const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true })

  const tables = new Set(
    (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(t => t.name)
  )
  const rows = (table: string, sql = `SELECT * FROM ${table}`): Row[] =>
    tables.has(table) ? (sqlite.prepare(sql).all() as Row[]) : []

  const db = getFirestore()
  const users = new FirestoreUserRepository(db)
  const profiles = new FirestoreProfileRepository(db)
  const conversations = new FirestoreConversationRepository(db)
  const tokens = new FirestoreWahooTokenRepository(db)
  const workouts = new FirestoreWorkoutRepository(db)

  const userRows = rows('users')
  for (const r of userRows) {
    await users.save(new User({ id: String(r.id), email: String(r.email), createdAt: String(r.created_at) }))
  }

  const profileRows = rows('cyclist_profiles')
  for (const r of profileRows) {
    await profiles.save(new CyclistProfile({
      userId: String(r.user_id),
      ftp: (r.ftp as number | null) ?? null,
      weightKg: (r.weight_kg as number | null) ?? null,
      hoursPerWeek: (r.hours_per_week as number | null) ?? null,
      goal: (r.goal as string | null) ?? null,
      experience: ((r.experience as Experience | null) ?? 'intermediate'),
      maxHr: (r.max_hr as number | null) ?? null,
      restingHr: (r.resting_hr as number | null) ?? null,
      availableDays: (r.available_days as string | null) ?? null,
      limitations: (r.limitations as string | null) ?? null,
      updatedAt: String(r.updated_at),
    }))
    // Free-text events stay as legacy `profile.targetEvents`; `npm run db:migrate-events` moves them to `events`
    if (r.target_events) {
      await db.collection('users').doc(String(r.user_id)).set({ profile: { targetEvents: r.target_events } }, { merge: true })
    }
  }

  const conversationRows = rows('conversations')
  const ownerOf = new Map<string, string>()
  for (const r of conversationRows) {
    ownerOf.set(String(r.id), String(r.user_id))
    await conversations.save(new Conversation({
      id: String(r.id),
      userId: String(r.user_id),
      title: (r.title as string | null) ?? 'Sesión',
      createdAt: String(r.created_at),
    }))
  }

  const messageRows = rows('messages')
  let orphanMessages = 0
  for (const r of messageRows) {
    const userId = ownerOf.get(String(r.conversation_id))
    if (!userId) { orphanMessages++; continue }
    await conversations.saveMessage(userId, new Message({
      id: String(r.id),
      conversationId: String(r.conversation_id),
      role: r.role as MessageRole,
      content: String(r.content),
      createdAt: String(r.created_at),
    }))
  }

  const tokenRows = rows('wahoo_tokens')
  for (const r of tokenRows) {
    await tokens.save(new WahooToken({
      userId: String(r.user_id),
      accessToken: decryptSecret(String(r.access_token)),
      refreshToken: decryptSecret(String(r.refresh_token)),
      expiresAt: String(r.expires_at),
      createdAt: String(r.created_at),
    }))
  }

  const workoutRows = rows('workouts', 'SELECT user_id, data FROM workouts')
  const byUser = new Map<string, WahooWorkout[]>()
  for (const r of workoutRows) {
    const list = byUser.get(String(r.user_id)) ?? []
    list.push(JSON.parse(String(r.data)) as WahooWorkout)
    byUser.set(String(r.user_id), list)
  }
  for (const [userId, list] of byUser) await workouts.upsertMany(userId, list)

  const syncRows = rows('workout_sync')
  for (const r of syncRows) {
    await workouts.saveSyncState(String(r.user_id), { lastSyncedAt: String(r.last_synced_at) })
  }

  sqlite.close()
  console.log('✓ Migración SQLite → Firestore completada')
  console.table({
    usuarios: userRows.length,
    perfiles: profileRows.length,
    conversaciones: conversationRows.length,
    mensajes: messageRows.length - orphanMessages,
    'mensajes huérfanos (omitidos)': orphanMessages,
    'tokens Wahoo': tokenRows.length,
    entrenos: workoutRows.length,
    'estados de sync': syncRows.length,
  })
}

main().catch(err => {
  console.error('✗', err instanceof Error ? err.message : err)
  process.exit(1)
})
