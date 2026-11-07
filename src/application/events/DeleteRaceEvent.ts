import { RaceEvent, RaceEventNotFoundError } from '../../domain/events/RaceEvent'
import { RaceEventRepository } from '../../domain/events/RaceEventRepository'

export class DeleteRaceEvent {
  constructor(private readonly events: RaceEventRepository) {}

  // Returns the deleted race. Throws RaceEventNotFoundError.
  async execute(userId: string, id: string): Promise<RaceEvent> {
    const event = await this.events.findById(userId, id)
    if (!event) throw new RaceEventNotFoundError()
    await this.events.delete(userId, id)
    return event
  }
}
