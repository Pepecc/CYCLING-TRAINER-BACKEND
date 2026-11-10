import { PlannedWorkoutNotFoundError } from '../../domain/planning/PlannedWorkout'
import { PlannedWorkoutRepository } from '../../domain/planning/PlannedWorkoutRepository'
import { CyclistProfileRepository } from '../../domain/profile/CyclistProfileRepository'
import { EXPORT_FORMATS, ExportError, ExportFormat, ExportedFile, WorkoutFileEncoder } from '../../domain/planning/workoutExport'

// Structured workout file of a planned workout (the active version: the adapted one if it was adapted)
export class ExportPlannedWorkout {
  private readonly encoders: Map<ExportFormat, WorkoutFileEncoder>

  constructor(
    private readonly plannedWorkouts: PlannedWorkoutRepository,
    private readonly profiles: CyclistProfileRepository,
    encoders: WorkoutFileEncoder[]
  ) {
    this.encoders = new Map(encoders.map(e => [e.format, e]))
  }

  // Throws ExportError or PlannedWorkoutNotFoundError
  async execute(userId: string, id: string, format: unknown): Promise<ExportedFile> {
    const encoder = typeof format === 'string' ? this.encoders.get(format as ExportFormat) : undefined
    if (!encoder) throw new ExportError(`Formato no válido: ${String(format)} (valores: ${EXPORT_FORMATS.join(', ')})`)

    const [workout, profile] = await Promise.all([
      this.plannedWorkouts.findById(userId, id),
      this.profiles.findByUserId(userId),
    ])
    if (!workout) throw new PlannedWorkoutNotFoundError()
    if (workout.blocks.length === 0) {
      throw new ExportError('Este entreno no tiene estructura (bloques y pasos): no hay nada que exportar')
    }
    return encoder.encode(workout, profile)
  }
}
