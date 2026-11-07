import { RaceEvent } from './RaceEvent'

// Carreras de cada usuario (fechas 'YYYY-MM-DD' en su zona horaria)
export interface RaceEventRepository {
  saveMany(events: RaceEvent[]): Promise<void>
  findById(userId: string, id: string): Promise<RaceEvent | null>
  findAll(userId: string): Promise<RaceEvent[]>                                     // por fecha
  findBetween(userId: string, fromKey: string, toKey: string): Promise<RaceEvent[]>  // por fecha de inicio, ambos incluidos
  delete(userId: string, id: string): Promise<void>
}
