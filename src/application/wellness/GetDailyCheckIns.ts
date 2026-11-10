import { CheckInValidationError, DailyCheckIn, Readiness, assessReadiness } from '../../domain/wellness/DailyCheckIn'
import { CheckInRepository } from '../../domain/wellness/CheckInRepository'
import { CyclistProfileRepository } from '../../domain/profile/CyclistProfileRepository'
import { addDays, dayKey, daysBetween } from '../../domain/training/calendar'

export interface CheckInWithReadiness {
  checkIn: DailyCheckIn
  readiness: Readiness
}

export interface CheckInAverages {
  days: number
  fatigue: number | null
  sleepHours: number | null
  sleepQuality: number | null
  feeling: number | null
  soreness: number | null
  morningHr: number | null
}

export interface CheckInRange {
  from: string
  to: string
  checkIns: CheckInWithReadiness[]
  averages: CheckInAverages
}

const MAX_RANGE_DAYS = 92
const BASELINE_DAYS = 14     // the readiness compares the morning HR with the previous two weeks
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/

export class GetDailyCheckIns {
  constructor(
    private readonly checkIns: CheckInRepository,
    private readonly profiles: CyclistProfileRepository
  ) {}

  // Defaults: the last 7 days up to today. Throws CheckInValidationError.
  async execute(userId: string, from?: string | null, to?: string | null): Promise<CheckInRange> {
    const toKey = to || dayKey(new Date())
    const fromKey = from || addDays(toKey, -6)
    for (const key of [fromKey, toKey]) {
      if (!DATE_KEY.test(key) || Number.isNaN(Date.parse(`${key}T12:00:00Z`))) {
        throw new CheckInValidationError(`Fecha no válida: ${key} (formato AAAA-MM-DD)`)
      }
    }
    if (toKey < fromKey) throw new CheckInValidationError('La fecha final es anterior a la inicial')
    if (daysBetween(fromKey, toKey) >= MAX_RANGE_DAYS) {
      throw new CheckInValidationError(`El rango no puede superar ${MAX_RANGE_DAYS} días`)
    }

    const [all, profile] = await Promise.all([
      this.checkIns.findBetween(userId, addDays(fromKey, -BASELINE_DAYS), toKey),
      this.profiles.findByUserId(userId),
    ])
    const inRange = all.filter(c => c.date >= fromKey)
    return {
      from: fromKey,
      to: toKey,
      checkIns: inRange.map(c => ({ checkIn: c, readiness: assessReadiness(c, all, profile?.restingHr ?? null) })),
      averages: averageCheckIns(inRange),
    }
  }

  // Today's check-in with its readiness, or null if there is none
  async today(userId: string): Promise<CheckInWithReadiness | null> {
    const today = dayKey(new Date())
    const r = await this.execute(userId, today, today)
    return r.checkIns[0] ?? null
  }

  async withReadiness(userId: string, checkIn: DailyCheckIn): Promise<CheckInWithReadiness> {
    const [recent, profile] = await Promise.all([
      this.checkIns.findBetween(userId, addDays(checkIn.date, -BASELINE_DAYS), addDays(checkIn.date, -1)),
      this.profiles.findByUserId(userId),
    ])
    return { checkIn, readiness: assessReadiness(checkIn, recent, profile?.restingHr ?? null) }
  }
}

export function averageCheckIns(list: DailyCheckIn[]): CheckInAverages {
  const avg = (pick: (c: DailyCheckIn) => number | null, decimals = 1): number | null => {
    const values = list.map(pick).filter((v): v is number => v !== null)
    if (!values.length) return null
    const f = 10 ** decimals
    return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * f) / f
  }
  return {
    days: list.length,
    fatigue: avg(c => c.fatigue),
    sleepHours: avg(c => c.sleepHours),
    sleepQuality: avg(c => c.sleepQuality),
    feeling: avg(c => c.feeling),
    soreness: avg(c => c.soreness),
    morningHr: avg(c => c.morningHr, 0),
  }
}
