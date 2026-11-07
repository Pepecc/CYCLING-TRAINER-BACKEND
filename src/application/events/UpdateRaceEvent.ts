import { RaceEvent, RaceEventInput, RaceEventNotFoundError } from '../../domain/events/RaceEvent'
import { RaceEventRepository } from '../../domain/events/RaceEventRepository'

export class UpdateRaceEvent {
  constructor(private readonly events: RaceEventRepository) {}

  // Throws RaceEventNotFoundError or RaceValidationError
  async execute(userId: string, id: string, patch: RaceEventInput): Promise<RaceEvent> {
    const event = await this.events.findById(userId, id)
    if (!event) throw new RaceEventNotFoundError()
    event.update(patch)
    await this.events.saveMany([event])
    return event
  }
}
