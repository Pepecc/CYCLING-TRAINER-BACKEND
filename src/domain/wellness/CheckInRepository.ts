import { DailyCheckIn } from './DailyCheckIn'

// Check-ins diarios de cada usuario, uno por día ('YYYY-MM-DD' en su zona horaria)
export interface CheckInRepository {
  save(checkIn: DailyCheckIn): Promise<void>
  findByDate(userId: string, date: string): Promise<DailyCheckIn | null>
  findBetween(userId: string, fromKey: string, toKey: string): Promise<DailyCheckIn[]>   // por fecha, ambos incluidos
  delete(userId: string, date: string): Promise<void>
}
