import { CheckInNotFoundError, CheckInValidationError } from '../../domain/wellness/DailyCheckIn'
import { CheckInRepository } from '../../domain/wellness/CheckInRepository'

export class DeleteDailyCheckIn {
  constructor(private readonly checkIns: CheckInRepository) {}

  // Throws CheckInNotFoundError
  async execute(userId: string, date: string): Promise<void> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new CheckInValidationError('La fecha debe tener el formato AAAA-MM-DD')
    if (!(await this.checkIns.findByDate(userId, date))) throw new CheckInNotFoundError()
    await this.checkIns.delete(userId, date)
  }
}
