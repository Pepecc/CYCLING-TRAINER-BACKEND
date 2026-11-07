import { PlannedWorkout } from './PlannedWorkout'

// Entrenos planificados de cada usuario (fechas 'YYYY-MM-DD' en su zona horaria)
export interface PlannedWorkoutRepository {
  saveMany(workouts: PlannedWorkout[]): Promise<void>
  findById(userId: string, id: string): Promise<PlannedWorkout | null>
  findBetween(userId: string, fromKey: string, toKey: string): Promise<PlannedWorkout[]>  // por fecha, ambos incluidos
  delete(userId: string, id: string): Promise<void>
}
