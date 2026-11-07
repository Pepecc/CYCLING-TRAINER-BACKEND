import { RaceEvent, RaceEventInput, RaceValidationError } from '../../domain/events/RaceEvent'
import { RaceEventRepository } from '../../domain/events/RaceEventRepository'

export const MAX_EVENTS_PER_SAVE = 30

export class SaveRaceEvents {
  constructor(private readonly events: RaceEventRepository) {}

  // All or nothing: if any race is invalid, nothing is saved. Throws RaceValidationError.
  async execute(userId: string, inputs: RaceEventInput[]): Promise<RaceEvent[]> {
    if (inputs.length === 0) throw new RaceValidationError('No hay carreras que guardar')
    if (inputs.length > MAX_EVENTS_PER_SAVE) {
      throw new RaceValidationError(`Como máximo ${MAX_EVENTS_PER_SAVE} carreras a la vez`)
    }

    const events = inputs.map((input, i) => {
      try {
        return RaceEvent.create(userId, input)
      } catch (err) {
        if (err instanceof RaceValidationError && inputs.length > 1) {
          throw new RaceValidationError(`Carrera ${i + 1}: ${err.message}`)
        }
        throw err
      }
    })

    await this.events.saveMany(events)
    return events
  }
}
