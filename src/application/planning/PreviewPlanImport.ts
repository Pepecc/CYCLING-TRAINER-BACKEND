import { PlannedWorkout, PlannedWorkoutInput, PlanValidationError, WorkoutEnvironment, WorkoutFocus } from '../../domain/planning/PlannedWorkout'
import { PlannedWorkoutRepository } from '../../domain/planning/PlannedWorkoutRepository'
import { ImportFormatError, ImportParseResult, PlanImportParser } from '../../domain/planning/PlanImport'
import { formatStructure } from '../../domain/planning/formatStructure'
import { CyclistProfileRepository } from '../../domain/profile/CyclistProfileRepository'
import { findExisting } from './importMatching'

export interface ImportPreviewItem {
  index: number
  draft: { externalId: string | null; input: PlannedWorkoutInput }   // lo que se envía para confirmar
  valid: boolean
  error: string | null
  warnings: string[]
  duplicateOf: string | null       // id del entreno ya guardado que coincide
  workout: {
    date: string
    title: string
    focus: WorkoutFocus
    environment: WorkoutEnvironment
    description: string | null
    durationMinutes: number | null
    plannedTss: number | null
    structure: string | null
  } | null
}

export interface ImportPreview {
  format: string
  total: number
  valid: number
  invalid: number
  duplicates: number
  from: string | null
  to: string | null
  totalHours: number
  totalTss: number
  warnings: string[]
  items: ImportPreviewItem[]
}

// Vista previa de una importación: convierte, valida cada entreno con las reglas del dominio
// (sin guardar nada) y marca los que ya están en el plan.
export class PreviewPlanImport {
  constructor(
    private readonly parsers: PlanImportParser[],
    private readonly plannedWorkouts: PlannedWorkoutRepository,
    private readonly profiles: CyclistProfileRepository
  ) {}

  // Throws ImportFormatError if no parser recognises the file
  async fromFile(userId: string, data: unknown): Promise<ImportPreview> {
    const parser = this.parsers.find(p => p.canParse(data))
    if (!parser) {
      throw new ImportFormatError(
        'Formato no reconocido. Se admite el JSON de entrenos de TrainingPeaks y el formato propio ({ "format": "cycling-coach", "workouts": [...] }).'
      )
    }
    const profile = await this.profiles.findByUserId(userId)
    return this.fromParsed(userId, parser.parse(data, profile))
  }

  async fromParsed(userId: string, parsed: ImportParseResult): Promise<ImportPreview> {
    const profile = await this.profiles.findByUserId(userId)
    const seen = new Set<string>()

    const items: ImportPreviewItem[] = parsed.drafts.map((d, index) => {
      const item: ImportPreviewItem = {
        index,
        draft: { externalId: d.externalId, input: d.input },
        valid: false,
        error: d.error,
        warnings: d.warnings,
        duplicateOf: null,
        workout: null,
      }
      if (d.error) return item
      if (d.externalId && seen.has(d.externalId)) {
        item.error = 'Repetido en el fichero'
        return item
      }
      if (d.externalId) seen.add(d.externalId)

      try {
        const w = PlannedWorkout.create(userId, d.input, 'import', profile, d.externalId)
        item.valid = true
        item.workout = {
          date: w.date,
          title: w.title,
          focus: w.focus,
          environment: w.environment,
          description: w.description,
          durationMinutes: w.durationMinutes,
          plannedTss: w.plannedTss,
          structure: w.blocks.length ? formatStructure(w.blocks, profile) : null,
        }
      } catch (err) {
        if (!(err instanceof PlanValidationError)) throw err
        item.error = err.message
      }
      return item
    })

    const valid = items.filter(i => i.valid)
    const existing = await findExisting(
      this.plannedWorkouts,
      userId,
      valid.map(i => ({ externalId: i.draft.externalId, date: i.workout!.date, title: i.workout!.title }))
    )
    valid.forEach((item, i) => { item.duplicateOf = existing[i]?.id ?? null })

    const dates = valid.map(i => i.workout!.date).sort()
    return {
      format: parsed.format,
      total: items.length,
      valid: valid.length,
      invalid: items.length - valid.length,
      duplicates: valid.filter(i => i.duplicateOf).length,
      from: dates[0] ?? null,
      to: dates[dates.length - 1] ?? null,
      totalHours: +(valid.reduce((a, i) => a + (i.workout!.durationMinutes ?? 0), 0) / 60).toFixed(1),
      totalTss: valid.reduce((a, i) => a + (i.workout!.plannedTss ?? 0), 0),
      warnings: parsed.warnings,
      items,
    }
  }
}
