import { CheckInInput, DailyCheckIn, parseCheckInDate } from '../../domain/wellness/DailyCheckIn'
import { CheckInRepository } from '../../domain/wellness/CheckInRepository'
import { dayKey } from '../../domain/training/calendar'
import { CheckInWithReadiness, GetDailyCheckIns } from './GetDailyCheckIns'

export class SaveDailyCheckIn {
  constructor(
    private readonly checkIns: CheckInRepository,
    private readonly getCheckIns: GetDailyCheckIns
  ) {}

  // Creates the day's check-in or merges the new values into it (undefined = keep, null = clear).
  // date defaults to today. Throws CheckInValidationError.
  async execute(userId: string, date: string | null | undefined, input: CheckInInput): Promise<CheckInWithReadiness> {
    const key = parseCheckInDate(date || dayKey(new Date()))
    const existing = await this.checkIns.findByDate(userId, key)
    let checkIn: DailyCheckIn
    if (existing) {
      existing.update(input)
      checkIn = existing
    } else {
      checkIn = DailyCheckIn.create(userId, key, input)
    }
    await this.checkIns.save(checkIn)
    return this.getCheckIns.withReadiness(userId, checkIn)
  }
}
