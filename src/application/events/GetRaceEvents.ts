import { RaceEvent } from '../../domain/events/RaceEvent'
import { RaceEventRepository } from '../../domain/events/RaceEventRepository'
import { addDays, dayKey } from '../../domain/training/calendar'

// Las vueltas por etapas empiezan antes de su último día: margen para no perder una que está en curso
const MAX_RACE_DAYS = 21

export class GetRaceEvents {
  constructor(private readonly events: RaceEventRepository) {}

  // Upcoming races (including one in progress). With includePast, also the ones of the last year.
  async execute(userId: string, includePast = false): Promise<RaceEvent[]> {
    const today = dayKey(new Date())
    const from = includePast ? addDays(today, -366) : addDays(today, -MAX_RACE_DAYS)
    const events = await this.events.findBetween(userId, from, addDays(today, 3 * 366))
    return includePast ? events : events.filter(e => e.endDate >= today)
  }
}
