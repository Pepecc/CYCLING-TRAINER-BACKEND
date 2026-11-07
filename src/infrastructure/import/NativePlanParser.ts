import {
  ImportDraft, ImportFormatError, ImportParseResult, PlanImportParser, MAX_IMPORT_WORKOUTS, pickImportInput,
} from '../../domain/planning/PlanImport'

// Formato propio: el mismo que devuelve GET /api/plan, así un plan exportado se puede volver a importar.
//   { "format": "cycling-coach", "workouts": [ { date, title, focus, environment, description, blocks,
//       durationMinutes, tss | plannedTss, notes, externalId? } ] }
// También vale la lista de entrenos sola. Los bloques usan el esquema del dominio:
//   { name, repeat, steps: [ { kind, durationSeconds, target: { type, min, max }, cadenceMin, cadenceMax, notes } ] }

export const NATIVE_FORMAT = 'cycling-coach'

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v)

export class NativePlanParser implements PlanImportParser {
  readonly format = NATIVE_FORMAT

  canParse(data: unknown): boolean {
    if (isRec(data) && data.format === NATIVE_FORMAT) return true
    const list = toList(data)
    return !!list && list.length > 0 && list.slice(0, 5).every(w => isRec(w) && 'date' in w && 'title' in w && !('workoutDay' in w))
  }

  parse(data: unknown): ImportParseResult {
    const list = toList(data)
    if (!list) throw new ImportFormatError('El fichero debe tener una lista "workouts" de entrenos')
    if (list.length === 0) throw new ImportFormatError('El fichero no tiene entrenos')
    if (list.length > MAX_IMPORT_WORKOUTS) {
      throw new ImportFormatError(`Como máximo ${MAX_IMPORT_WORKOUTS} entrenos por importación (el fichero tiene ${list.length})`)
    }
    return { format: this.format, drafts: list.map((raw, i) => toDraft(raw, i)), warnings: [] }
  }
}

function toList(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data
  if (isRec(data) && Array.isArray(data.workouts)) return data.workouts
  return null
}

function toDraft(raw: unknown, index: number): ImportDraft {
  if (!isRec(raw)) return { externalId: null, input: {}, warnings: [], error: `Entrada ${index + 1}: no es un objeto` }
  const input = pickImportInput(raw)
  if (input.tss === undefined && raw.plannedTss !== undefined) input.tss = raw.plannedTss
  // Duration and TSS of structured workouts are recalculated from the blocks
  if (Array.isArray(input.blocks) && input.blocks.length > 0) {
    delete input.durationMinutes
    delete input.tss
  }

  const externalId = typeof raw.externalId === 'string' && raw.externalId.trim()
    ? raw.externalId.trim().slice(0, 200)
    : typeof raw.id === 'string' && raw.id.trim() ? `${NATIVE_FORMAT}:${raw.id.trim()}` : null
  return { externalId, input, warnings: [], error: null }
}
