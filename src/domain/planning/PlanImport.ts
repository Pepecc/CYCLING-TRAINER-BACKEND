import { LoadProfile } from '../training/trainingMetrics'
import { PlannedWorkoutInput } from './PlannedWorkout'
import { ImageInput } from '../chat/ImageAttachment'

// Importación de planes: cualquier origen (JSON de TrainingPeaks, JSON propio, foto de una tabla)
// se convierte primero en borradores con el mismo esquema que acepta PlannedWorkout. Los borradores
// se validan y se muestran en una vista previa; solo se guardan cuando el ciclista los confirma.

export interface ImportDraft {
  externalId: string | null      // id en el origen ('trainingpeaks:123'); evita duplicar al reimportar
  input: PlannedWorkoutInput     // campos en el formato del dominio (camelCase, bloques con durationSeconds)
  warnings: string[]             // lo que se ha aproximado o descartado al convertir
  error: string | null           // la entrada no se puede convertir (no se podrá guardar)
}

export interface ImportParseResult {
  format: string                 // 'trainingpeaks' | 'cycling-coach' | 'image'
  drafts: ImportDraft[]
  warnings: string[]             // avisos del fichero en conjunto
}

// Adaptador de un formato de fichero. Throws ImportFormatError si el fichero no tiene la forma esperada.
export interface PlanImportParser {
  readonly format: string
  canParse(data: unknown): boolean
  parse(data: unknown, profile: LoadProfile | null): ImportParseResult
}

// Extrae de una imagen (foto o captura de una tabla de entrenos) los borradores del plan
export interface PlanImageExtractor {
  extract(image: ImageInput, context: { today: string; hint: string | null; profile: LoadProfile | null }): Promise<ImportParseResult>
}

export class ImportFormatError extends Error {}

// Campos de un entreno que se pueden importar (el estado siempre empieza en 'planned')
export const IMPORT_FIELDS: Array<keyof PlannedWorkoutInput> = [
  'date', 'title', 'focus', 'environment', 'description', 'blocks', 'durationMinutes', 'tss', 'notes',
]

export function pickImportInput(raw: unknown): PlannedWorkoutInput {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const input: PlannedWorkoutInput = {}
  for (const key of IMPORT_FIELDS) {
    if (src[key] !== undefined) input[key] = src[key]
  }
  return input
}

export const MAX_IMPORT_WORKOUTS = 500
