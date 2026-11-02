import { WahooWorkout } from './WahooWorkout'

export interface WorkoutSyncState {
  lastSyncedAt: string   // ISO — última sincronización correcta con Wahoo
}

// Copia local de los entrenos de Wahoo de cada usuario
export interface WorkoutRepository {
  upsertMany(userId: string, workouts: WahooWorkout[]): Promise<void>
  findSince(userId: string, since: Date): Promise<WahooWorkout[]>        // más recientes primero
  findPage(userId: string, offset: number, limit: number): Promise<WahooWorkout[]>
  getSyncState(userId: string): Promise<WorkoutSyncState | null>
  saveSyncState(userId: string, state: WorkoutSyncState): Promise<void>
  deleteAllForUser(userId: string): Promise<void>                       // entrenos + estado de sync
}
