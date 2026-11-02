import { WahooOAuthService, WahooNotConnectedError } from '../../infrastructure/wahoo/WahooOAuthService'
import { WorkoutRepository } from '../../domain/wahoo/WorkoutRepository'
import { dayKey, addDays } from '../../domain/training/calendar'

// No volver a preguntar a Wahoo si se sincronizó hace menos de esto
const MIN_SYNC_INTERVAL_MS = 5 * 60 * 1000
// En cada sync incremental se repasan los últimos días: Wahoo puede añadir
// el workout_summary (NP, TSS...) un rato después de crear el entreno
const RESYNC_OVERLAP_DAYS = 7
// Historial de la primera sincronización: un año, y como mínimo desde
// 90 días antes del 1 de enero (lo que necesita el cálculo de CTL de temporada)
const CTL_WARMUP_DAYS = 90

export class SyncWahooWorkouts {
  // One sync per user at a time: parallel tool calls share the same promise
  private readonly inFlight = new Map<string, Promise<void>>()

  constructor(
    private readonly wahooService: WahooOAuthService,
    private readonly workoutRepository: WorkoutRepository
  ) {}

  async execute(userId: string, { force = false }: { force?: boolean } = {}): Promise<void> {
    const running = this.inFlight.get(userId)
    if (running) return running

    const promise = this.sync(userId, force).finally(() => this.inFlight.delete(userId))
    this.inFlight.set(userId, promise)
    return promise
  }

  private async sync(userId: string, force: boolean): Promise<void> {
    const state = await this.workoutRepository.getSyncState(userId)
    const now = new Date()

    if (state && !force && now.getTime() - new Date(state.lastSyncedAt).getTime() < MIN_SYNC_INTERVAL_MS) {
      return
    }

    const since = state
      ? new Date(new Date(state.lastSyncedAt).getTime() - RESYNC_OVERLAP_DAYS * 24 * 3600 * 1000)
      : initialHistoryStart(now)

    try {
      const workouts = await this.wahooService.getWorkoutsSince(userId, since)
      await this.workoutRepository.upsertMany(userId, workouts)
      await this.workoutRepository.saveSyncState(userId, { lastSyncedAt: now.toISOString() })
    } catch (err) {
      // With a previous copy we can keep answering from it; without one, or if
      // the user disconnected Wahoo, the error must reach the caller
      if (!state || err instanceof WahooNotConnectedError) throw err
      console.warn(`Wahoo sync failed for ${userId}, using cached workouts:`, (err as Error).message)
    }
  }
}

function initialHistoryStart(now: Date): Date {
  const today = dayKey(now)
  const yearAgo = addDays(today, -365)
  const warmup = addDays(`${today.slice(0, 4)}-01-01`, -CTL_WARMUP_DAYS)
  return new Date(`${yearAgo < warmup ? yearAgo : warmup}T00:00:00Z`)
}
