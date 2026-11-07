import { RaceEventRepository } from '../../domain/events/RaceEventRepository'
import { buildSeasonPlan, SeasonPlan } from '../../domain/events/seasonPlan'
import { addDays, dayKey } from '../../domain/training/calendar'

export class GetSeasonPlan {
  constructor(private readonly events: RaceEventRepository) {}

  async execute(userId: string): Promise<SeasonPlan> {
    const today = dayKey(new Date())
    // The last month is enough to know if the cyclist is recovering from an A race
    const events = await this.events.findBetween(userId, addDays(today, -40), addDays(today, 3 * 366))
    return buildSeasonPlan(events, today)
  }
}
