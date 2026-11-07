import { PlannedWorkout, PlanValidationError } from '../../domain/planning/PlannedWorkout'
import { PlannedWorkoutRepository } from '../../domain/planning/PlannedWorkoutRepository'
import { MAX_IMPORT_WORKOUTS, pickImportInput } from '../../domain/planning/PlanImport'
import { CyclistProfileRepository } from '../../domain/profile/CyclistProfileRepository'
import { findExisting } from './importMatching'

// skip: los que ya están en el plan se dejan como están · replace: se sobrescriben (conservan id y estado)
export type DuplicatePolicy = 'skip' | 'replace'

export interface ImportResult {
  created: number
  updated: number
  skipped: number
  from: string
  to: string
  workouts: PlannedWorkout[]       // creados y actualizados
}

const MAX_ERRORS_SHOWN = 5

// Guarda los borradores confirmados por el ciclista (los de la vista previa, quizá editados).
// Todo o nada: si alguno no es válido, no se guarda ninguno.
export class ImportPlannedWorkouts {
  constructor(
    private readonly plannedWorkouts: PlannedWorkoutRepository,
    private readonly profiles: CyclistProfileRepository
  ) {}

  // drafts: [{ externalId?, input }]. Throws PlanValidationError.
  async execute(userId: string, drafts: unknown[], onDuplicate: DuplicatePolicy = 'skip'): Promise<ImportResult> {
    if (drafts.length === 0) throw new PlanValidationError('No hay entrenos que importar')
    if (drafts.length > MAX_IMPORT_WORKOUTS) {
      throw new PlanValidationError(`Como máximo ${MAX_IMPORT_WORKOUTS} entrenos por importación`)
    }

    const profile = await this.profiles.findByUserId(userId)
    const errors: string[] = []
    const seen = new Set<string>()

    const workouts = drafts.map((raw, i) => {
      const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      const externalId = typeof d.externalId === 'string' && d.externalId.trim() ? d.externalId.trim().slice(0, 200) : null
      if (externalId && seen.has(externalId)) {
        errors.push(`Entreno ${i + 1}: repetido (${externalId})`)
        return null
      }
      if (externalId) seen.add(externalId)
      try {
        return PlannedWorkout.create(userId, pickImportInput(d.input), 'import', profile, externalId)
      } catch (err) {
        if (!(err instanceof PlanValidationError)) throw err
        errors.push(`Entreno ${i + 1}: ${err.message}`)
        return null
      }
    })

    if (errors.length) {
      const more = errors.length > MAX_ERRORS_SHOWN ? ` (y ${errors.length - MAX_ERRORS_SHOWN} errores más)` : ''
      throw new PlanValidationError(`No se ha importado nada. ${errors.slice(0, MAX_ERRORS_SHOWN).join(' · ')}${more}`)
    }

    const valid = workouts as PlannedWorkout[]
    const existing = await findExisting(this.plannedWorkouts, userId, valid)

    const toSave: PlannedWorkout[] = []
    let created = 0
    let updated = 0
    let skipped = 0
    // Same-day workouts are listed by createdAt: keep the file order
    const base = Date.now()

    valid.forEach((w, i) => {
      const current = existing[i]
      if (!current) {
        const stamp = new Date(base + i).toISOString()
        toSave.push(new PlannedWorkout({ ...w, createdAt: stamp, updatedAt: stamp }))
        created++
      } else if (onDuplicate === 'replace' && !toSave.includes(current)) {
        // Keeps id, status and createdAt; the content is replaced by the imported one (and any adaptation dropped)
        current.clearAdaptation()
        current.update(
          { description: null, notes: null, blocks: null, ...pickImportInput((drafts[i] as Record<string, unknown>).input) },
          profile
        )
        toSave.push(current)
        updated++
      } else {
        skipped++
      }
    })

    if (toSave.length) await this.plannedWorkouts.saveMany(toSave)
    const dates = valid.map(w => w.date).sort()
    return { created, updated, skipped, from: dates[0], to: dates[dates.length - 1], workouts: toSave }
  }
}
